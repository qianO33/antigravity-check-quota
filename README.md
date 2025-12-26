# Antigravity Check Quota Script

This is a standalone tool to retrieve and display your Codeium quota and license information directly from running Codeium processes (e.g., in VS Code).

## Prerequisites

- **Node.js**: Version **18 or higher** is required.
- **PNPM**: Package manager (optional, but recommended).
- **Active Codeium Session**: You must have an IDE (like VS Code) open with the Codeium extension running and logged in.

## Installation

1. Clone or download this repository.
2. Install dependencies:

```bash
pnpm install
# or
npm install
```

## Usage

### Development Mode

Run the TypeScript script directly without building:

```bash
pnpm start
# or
npm start
```

### Build for Production

To bundle the script into a single, minified JavaScript file:

```bash
pnpm build
# or
npm run build
```

This will generate a `dist/check-quota.js` file.

### Run Production Build

After building, you can run the standalone JavaScript file:

```bash
pnpm start:prod
# or
node dist/check-quota.js
```

## Troubleshooting

- **No process found**: Ensure your IDE with Codeium is running.
- **Permission denied**: On macOS/Linux, `lsof` might require permissions. Try running with `sudo` if ports aren't detected (though usually not required for user-owned processes).
