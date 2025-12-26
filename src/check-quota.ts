#!/usr/bin/env ts-node
import { exec } from 'child_process';
import { promisify } from 'util';
import * as https from 'https';

const execAsync = promisify(exec);

/**
 * 独立配额获取脚本 (check-quota.ts)
 * 逻辑：寻找 Codeium 进程 -> 提取 CSRF Token -> 探测端口 -> 请求 API
 */

async function main() {
  console.log('🚀 开始获取 Codeium 配额信息...');

  try {
    // 1. 查找进程
    const processName = process.platform === 'darwin' ? 'language_server_macos' :
      process.platform === 'win32' ? 'language_server_windows_x64.exe' :
        'language_server_linux';

    console.log(`🔍 正在查找进程: ${processName}`);

    let psCommand = '';
    if (process.platform === 'win32') {
      psCommand = `wmic process where "name='${processName}'" get commandline,processid /format:list`;
    } else {
      psCommand = `ps -ww -eo pid,args | grep "${processName}" | grep -v grep`;
    }

    // 增加 buffer 限制防止进程过多导致溢出
    const { stdout: psStdout } = await execAsync(psCommand, { maxBuffer: 1024 * 1024 * 5 });
    if (!psStdout.trim()) {
      throw new Error(`未找到正在运行的 ${processName} 进程，请确保 VS Code 或相关工具正在运行并已登录 Codeium。`);
    }

    // 2. 提取所有候选 PID 和 Token
    const candidates: { pid: number, csrfToken: string }[] = [];

    if (process.platform === 'win32') {
      const lines = psStdout.trim().split('\r\n').filter((l: string) => l.trim());
      let currentCmd = '';
      let currentPid = '';

      for (const line of lines) {
        if (line.startsWith('CommandLine=')) {
          currentCmd = line.substring(12);
        } else if (line.startsWith('ProcessId=')) {
          currentPid = line.substring(10);
          if (currentCmd && currentPid) {
            const tokenMatch = currentCmd.match(/--csrf_token[=\s]+([a-f0-9\-]+)/i);
            if (tokenMatch) {
              candidates.push({
                pid: parseInt(currentPid, 10),
                csrfToken: tokenMatch[1]
              });
            }
          }
          currentCmd = '';
          currentPid = '';
        }
      }
    } else {
      const lines = psStdout.trim().split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pidVal = parseInt(parts[0], 10);
        const tokenMatch = line.match(/--csrf_token[=\s]+([a-f0-9\-]+)/i);

        if (!isNaN(pidVal) && tokenMatch) {
          candidates.push({
            pid: pidVal,
            csrfToken: tokenMatch[1]
          });
        }
      }
    }

    if (candidates.length === 0) {
      throw new Error('未发现任何带有 CSRF Token 的 Codeium 进程。');
    }

    // 去重
    const uniqueCandidates = Array.from(new Map(candidates.map(item => [item.pid, item])).values());
    console.log(`✅ 找到 ${uniqueCandidates.length} 个潜在进程: ${uniqueCandidates.map(c => c.pid).join(', ')}`);

    // 3. 遍历每个 PID 查找端口 (并行查找)
    console.log('🔎 正在扫描进程监听端口...');

    // 并行获取所有进程的端口
    const pidPortResults = await Promise.all(
      uniqueCandidates.map(async (cand) => {
        try {
          const ports = await getListeningPorts(cand.pid);
          return ports.map(port => ({ port, token: cand.csrfToken, pid: cand.pid }));
        } catch (e) {
          return [];
        }
      })
    );

    const allPorts = pidPortResults.flat();

    if (allPorts.length === 0) {
      console.error('\n❌ 所有检测到的进程均未发现本地监听端口。这可能是因为：');
      console.error('   1. lsof/netstat/ss 命令权限不足 (尝试 sudo?)');
      console.error('   2. 进程监听端口的方式未被脚本捕获');
      console.error('   3. 您在某些不能直接访问端口的远程开发环境');
      throw new Error('所有候选进程均未发现端口。');
    }

    // 4. 去重并探测
    const uniquePorts = Array.from(new Set(allPorts.map(p => p.port)));
    console.log(`📡 发现 ${uniquePorts.length} 个候选端口: ${uniquePorts.join(', ')}，并行探测可用性...`);

    // 并行测试所有端口
    const testPromises = uniquePorts.map(async (p) => {
      const matchingCandidate = allPorts.find(wp => wp.port === p);
      if (!matchingCandidate) return null;

      const isWorking = await testPort(p, matchingCandidate.token);
      if (isWorking) {
        return { port: p, token: matchingCandidate.token };
      }
      return null;
    });

    const results = await Promise.all(testPromises);
    const validResult = results.find(r => r !== null);

    if (!validResult) {
      throw new Error('未能找到可用的 API 响应端口。');
    }

    const { port: workingPort, token: validToken } = validResult;

    console.log(`✨ 确定工作端口: ${workingPort}，正在获取配额数据...`);

    // 5. 调用 GetUserStatus 获取配额
    const quotaData = await fetchUserStatus(workingPort, validToken);

    // 6. 打印结果
    printQuotaSummary(quotaData);

  } catch (error: any) {
    console.error(`\n❌ 出错了: ${error.message}`);
    process.exit(1);
  }
}

async function getListeningPorts(pid: number): Promise<number[]> {
  let portStdout = '';
  const commands = [];
  if (process.platform === 'darwin') {
    commands.push({ name: 'lsof', cmd: `lsof -Pan -p ${pid} -i` });
    // netstat fallback for Mac is poor as it doesn't show PID easily, but we rely on lsof
  } else if (process.platform === 'win32') {
    commands.push({ name: 'netstat', cmd: `netstat -ano | findstr LISTENING | findstr ${pid}` });
  } else {
    commands.push({ name: 'ss', cmd: `ss -tlnp | grep "pid=${pid},"` });
    commands.push({ name: 'netstat', cmd: `netstat -tulpn | grep ${pid}` });
    commands.push({ name: 'lsof', cmd: `lsof -Pan -p ${pid} -i` });
  }

  for (const { name, cmd } of commands) {
    try {
      const { stdout } = await execAsync(cmd);
      if (stdout.trim()) {
        portStdout = stdout;
        break;
      }
    } catch (e: any) {
      // ignore errors
    }
  }

  const ports: number[] = [];
  if (portStdout) {
    const lines = portStdout.split('\n');
    for (const line of lines) {
      const match = line.match(/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|\*):(\d+)/);
      if (match && match[1]) {
        const port = parseInt(match[1], 10);
        if (!ports.includes(port)) ports.push(port);
      }
    }
  }
  return ports;
}

/**
 * 测试端口是否响应 Codeium API
 */
async function testPort(port: number, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ metadata: { ideName: 'node-script' } });
    const options = {
      hostname: '127.0.0.1',
      port,
      path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Codeium-Csrf-Token': token,
        'Connect-Protocol-Version': '1'
      },
      rejectUnauthorized: false,
      timeout: 1000
    };

    const req = https.request(options, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(postData);
    req.end();
  });
}

/**
 * 获取用户状态和配额
 */
async function fetchUserStatus(port: number, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      metadata: {
        ideName: 'antigravity',
        extensionName: 'antigravity',
        locale: 'en'
      }
    });
    const options = {
      hostname: '127.0.0.1',
      port,
      path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Codeium-Csrf-Token': token,
        'Connect-Protocol-Version': '1'
      },
      rejectUnauthorized: false
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('解析响应 JSON 失败'));
          }
        } else {
          reject(new Error(`API 请求失败: ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * 美化打印配额摘要
 */
function printQuotaSummary(data: any) {
  const userStatus = data.userStatus;
  const planStatus = userStatus.planStatus;
  const planInfo = planStatus?.planInfo;
  const modelConfigs = userStatus.cascadeModelConfigData?.clientModelConfigs || [];

  console.log('\n' + '='.repeat(40));
  console.log(`👤 用户: ${userStatus.name} (${userStatus.email})`);
  console.log(`📦 套餐: ${planInfo?.planName || 'Unknown'}`);
  console.log('='.repeat(40));

  if (planStatus?.availablePromptCredits !== undefined) {
    const total = planInfo?.monthlyPromptCredits || 0;
    const avail = planStatus.availablePromptCredits;
    const percent = total > 0 ? (avail / total * 100).toFixed(1) : 'N/A';
    console.log(`💳 总配额 (Prompt Credits): ${avail} / ${total} (${percent}%)`);
  }

  console.log('\n🤖 模型详情配额:');
  console.log('-'.repeat(40));

  for (const config of modelConfigs) {
    if (config.quotaInfo) {
      const label = config.label;
      const fraction = config.quotaInfo.remainingFraction ?? 0;
      const percent = (fraction * 100).toFixed(1);
      const reset = new Date(config.quotaInfo.resetTime).toLocaleString();

      let indicator = '🟢';
      if (fraction <= 0) indicator = '⚫';
      else if (fraction <= 0.3) indicator = '🔴';
      else if (fraction <= 0.5) indicator = '🟡';

      console.log(`${indicator} ${label.padEnd(20)} | 剩余: ${percent.padStart(5)}% | 重置时间: ${reset}`);
    }
  }
  console.log('='.repeat(40) + '\n');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n❌ Fatal Error: ${error.message}`);
    process.exit(1);
  });
}
