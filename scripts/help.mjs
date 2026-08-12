#!/usr/bin/env node

const help = `codex-web commands

Operators
  npm run server                 Start from already-built local artifacts.
  npm run server:lan             Start on the trusted LAN (0.0.0.0).
  npm run server -- --port 9000  Choose a listener port.
  npm run rebuild                Rebuild server and browser artifacts; may take time.
  npm run server:rebuild         Rebuild, then start the loopback server.

Maintainers and CI
  npm run check                  Run normal type, test, proxy, and format checks.
  npm run build                  Re-extract and patch the pinned Desktop archive, then build.
  npm run typecheck              Run the server and browser TypeScript checks.
  npm test                       Run the complete Vitest suite.
  npm run test:<name>            Run one focused compatibility/proxy/archive check.

Upstream Desktop development
  npm run upstream:webview       Serve the extracted upstream webview at :5175.
  npm run upstream:electron      Launch the extracted upstream Electron app.
  npm run browser:dev            Run Vite's browser development server.
`;

process.stdout.write(help);
