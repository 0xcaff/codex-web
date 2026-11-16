# Developing codex-web Locally with an Existing app-server

## 1. Overview

This guide explains how to develop and run a locally checked-out copy of
`codex-web` while connecting it to an already-running `codex app-server`.

The goal is to modify the `codex-web` source code and see the changes without
restarting the existing `app-server`.

The recommended setup is:

| Component | Configuration |
| --- | --- |
| Frontend | Vite Dev Server |
| Backend | Node.js Server |
| Frontend-to-backend communication | WebSocket / HTTP proxy |
| app-server | Existing process |
| Backend-to-app-server communication | WebSocket over a Unix Domain Socket |

This setup allows you to restart the `codex-web` backend independently without
interrupting the existing `app-server`.

## 2. Obtaining the Repository

Clone the repository and install its dependencies:

```bash
git clone https://github.com/0xcaff/codex-web.git
cd codex-web

npm ci
```

`npm ci` installs the dependencies and, unless lifecycle scripts are disabled,
runs the `prepare` lifecycle script. You do not need to run `npm run prepare`
separately after a successful default installation.

The preparation process performs the following operations:

- Downloads the Codex Desktop application archive.
- Extracts the application into `scratch/asar`.
- Applies the patches in `patches/`.
- Builds the browser frontend.
- Compiles the Node.js server from TypeScript.

Unlike a typical React application, `codex-web` requires the extracted Codex
Desktop application as its source of frontend code.

## 3. Connecting to an Existing app-server

To connect to an existing `app-server`, configure `codex_remote_proxy` to forward
the app-server protocol over a Unix Domain Socket.

Set the socket path exposed by your existing `app-server`:

```bash
export CODEX_UNIX_SOCKET="$HOME/.codex/app-server-control/app-server-control.sock"
```

**Note:** This path is an environment-dependent example, not a default guaranteed
by this repository. Use the actual socket path provided by your setup. The socket
must exist and accept app-server protocol connections over WebSocket; the
existence of a socket file alone does not establish compatibility. Verify the
connection in your environment.

The [README's advanced usage](../../README.md#proxying-to-app-server-advanced-usage)
starts a separate app-server with `--listen unix://codex-app-server.sock` from
`/tmp/codex-app-server` and then sets
`CODEX_UNIX_SOCKET=/tmp/codex-app-server/codex-app-server.sock`. This guide instead
uses a socket exposed by an existing process. In both cases, `CODEX_UNIX_SOCKET`
is a filesystem path, without the `unix://` prefix used by `--listen`.

### Using the repository script

Make sure `websocat` is available in your `PATH`, then set `CODEX_CLI_PATH` to the
repository's proxy script instead of the standard Codex CLI executable:

```bash
export CODEX_CLI_PATH="$(pwd)/scripts/codex_remote_proxy"
```

Run this command from the repository root. The script forwards standard
input/output to the Unix Domain Socket using `websocat`.

### Using Nix

Alternatively, enter a shell with the repository's packaged proxy:

```bash
nix shell .#codex_remote_proxy
export CODEX_CLI_PATH="$(command -v codex_remote_proxy)"
```

The packaged proxy wraps the script with its runtime dependencies, including
`websocat`. It does not add `websocat` itself to the interactive shell's `PATH`,
so use the packaged `codex_remote_proxy` executable for this option rather than
`scripts/codex_remote_proxy`.

Keep this shell active when running the Node.js server. It inherits the
`CODEX_UNIX_SOCKET` exported above.

## 4. Launching the Node.js Server

In the terminal configured in section 3, stay in the repository root. If you open
a new terminal, repeat section 3 there, including your chosen proxy setup.

Compile the Node.js server and launch it directly:

```bash
npm run build:server
node src/server/main.js
```

The backend listens on <http://127.0.0.1:8214> by default.

### Why launch the server directly?

The standard `npm run server` script explicitly sets `CODEX_CLI_PATH` to the Codex
CLI executable:

```bash
CODEX_CLI_PATH=$(which codex) node src/server/main.js
```

This overrides the proxy configuration required to connect to the existing
`app-server`. Its `preserver` lifecycle script also rebuilds the server and browser.

Launching `src/server/main.js` directly preserves the `CODEX_CLI_PATH` configured
in the current shell.

## 5. Launching the Frontend in Development Mode

Open another terminal in the repository root.

Start the Vite development server:

```bash
npm run dev:browser
```

The frontend will be available at <http://127.0.0.1:4173> by default. If that port
is occupied, Vite may choose another port; check its terminal output for the URL.

The Vite configuration proxies backend requests as follows:

| Path | Destination |
| --- | --- |
| `/__backend/ipc` | `ws://127.0.0.1:8214` |
| `/__backend/upload` | `http://127.0.0.1:8214` |

The resulting communication flow is:

```text
Browser
   |
   | HTTP
   v
Vite Dev Server (:4173)
   |
   | WebSocket / HTTP proxy
   v
Node.js Server (:8214)
   |
   | WebSocket over a Unix Domain Socket
   v
Existing app-server
```

Open <http://127.0.0.1:4173> in your browser. Frontend changes are reflected
through Vite's Hot Module Replacement (HMR) or a page reload, depending on the
module being changed.

## 6. Rebuilding After Changes

The required operations depend on which part of the source code you modify.

| Change target | Required operation |
| --- | --- |
| `src/browser/` | Vite handles updates through HMR or a page reload. |
| `src/server/` | Run `npm run build:server` and restart the Node.js server. |
| `patches/` | Stop the development processes, run `npm run prepare`, and restart them. |

Changes to `patches/` require re-extracting the Codex Desktop application and
reapplying the patches. `npm run prepare` downloads and extracts the application,
applies the patches, and rebuilds both the frontend and server.

Preserve any manual edits to `scratch/asar` in patches before preparing again,
since preparation can overwrite the extracted files. If you modify the extracted
application directly, restart the relevant development processes as necessary to
ensure the changes are loaded.

These rebuilds and restarts apply to `codex-web`; leave the existing `app-server`
running.

## 7. Security Considerations

`codex-web` can access files and execute commands on the host machine using the
permissions of the server process. Treat anyone who can reach the service as
someone who can operate Codex as that user, including accessing its files,
credentials, and signed-in account.

Do not expose the backend or development server directly to the public internet.
Both servers bind to loopback addresses by default:

- Node.js backend: `127.0.0.1:8214`
- Vite Dev Server: `127.0.0.1:4173`

If remote access is required, use a trusted network such as Tailscale or an SSH
tunnel. For deployments accessible to other users, put an authentication and
authorization layer in front of the service. Network connectivity alone should
not be treated as authentication.

See the [README's security policy](../../README.md#security) for the project's
access and deployment guidance.
