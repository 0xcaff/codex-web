# Contributing to codex-web

## Commands

### Operators

| Command                  | When to use it                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `npm run server`         | Start previously built local artifacts. It has no hidden rebuild lifecycle.                                                        |
| `npm run server:lan`     | Start for a trusted LAN. Read the warning in the startup output.                                                                   |
| `npm run rebuild`        | Rebuild server/browser output from the extracted Desktop files. Browser compression is intentionally explicit and prints progress. |
| `npm run server:rebuild` | Rebuild and then start the loopback server.                                                                                        |

### Maintainers and CI

| Command                                  | Purpose                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                          | Extract the pinned Desktop archive, apply the ordered compatibility patches, and build both outputs. Requires a prepared archive or `HOSTED_CODEX_APP_ZIP`. |
| `npm run build:browser` / `build:server` | Internal build composition used by `build`, `rebuild`, and CI.                                                                                              |
| `npm run typecheck`                      | Both TypeScript projects; `typecheck:browser` and `typecheck:server` are focused variants.                                                                  |
| `npm test`                               | All Vitest tests.                                                                                                                                           |
| `npm run test:compatibility`             | Shell fixture for patch-series overlap/missing-anchor failures.                                                                                             |
| `npm run test:remote-proxy`              | Ensures the Unix-socket proxy invokes `websocat` safely.                                                                                                    |
| `npm run test:archive-verifier`          | Tests the Desktop archive digest verifier.                                                                                                                  |
| `npm run test:server-launcher`           | Verifies explicit proxy preservation and rebuild argument forwarding.                                                                                       |
| `npm run test:server-signal`             | Verifies launcher termination reaches the active server child.                                                                                              |
| `npm run test:server-real-signal`        | Verifies the real launcher shuts down the server, closes its port, and terminates the upstream Codex child.                                                 |
| `npm run test:runtime-logging`           | Verifies upstream payload suppression and trusted operator output.                                                                                          |
| `npm run check`                          | Normal pre-commit/CI suite: version check, types, tests, proxy/archive checks, and formatting.                                                              |

### Upstream Desktop development

These commands are for diagnosing the extracted upstream Desktop application,
not everyday codex-web operation:

| Command                     | Purpose                                             |
| --------------------------- | --------------------------------------------------- |
| `npm run upstream:webview`  | Serve `scratch/asar/webview` directly on port 5175. |
| `npm run upstream:electron` | Run the extracted upstream Electron application.    |
| `npm run browser:dev`       | Run Vite’s standalone browser development server.   |

## Logging

Normal server output is limited to readiness, warnings, and failures.
`CODEX_WEB_DEBUG=1` enables Electron-stub call tracing for compatibility
diagnosis. The tracer reports method names and bounded argument shapes, never
raw renderer payloads, credentials, settings, or account data. The upstream
Desktop console remains suppressed in debug mode because its entries cannot be
reliably sanitized after formatting. The runtime forces the upstream structured
logger to error level and emits at most one static suppression marker per
upstream console severity.
