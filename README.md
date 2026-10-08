# codex-web

a browser frontend for codex desktop, running on a machine you control.

https://github.com/user-attachments/assets/0a33cbd8-741c-412c-9e75-46dfe9324596

The optional Linux shared mode provides persistent sessions, Desktop tool
compatibility, and configurable LAN access. Compressed browser assets and cached
live IPC traffic reduce repeated downloads on mobile connections.
[中文安装与使用说明（从依赖安装到日常使用）](docs/shared-sessions.zh-CN.md).

## start here: Linux shared sessions

Use this path if you want a computer/SSH terminal and a phone browser to operate
the same live session. Install on the Linux computer that will run Codex, as your
normal user. The browser is only a client; it does not need Node or Codex installed.

**There is currently no website login.** Start with local access. Enable LAN access
only on a trusted network; anyone who can reach the server can operate Codex with
your Linux user's permissions. `codex login` signs the server into OpenAI; it does
not authenticate visitors to your website.

Before cloning, install Git, curl, unzip, patch, Python 3, Node 22.12+ with npm,
Codex CLI 0.160.1+, and websocat. Persistent shared services require Linux with
`systemd --user`; they are separate from the basic macOS/standalone mode below.
For step-by-step dependency commands, follow the
[Ubuntu/Debian preparation guide](docs/shared-sessions.zh-CN.md#1-准备电脑).
The shared runtime has been tested with Codex 0.160.1; newer CLI releases need
their own verification. Installing the official Desktop app or its tool plugin
is optional for basic shared sessions.

Once dependencies are ready:

```bash
codex login --device-auth
git clone https://github.com/0xcaff/codex-web.git
cd codex-web
npm ci
python3 scripts/install-services.py --access local --restart
systemctl --user is-active codex-shared.service codex-web.service
node scripts/check-connection.cjs http://127.0.0.1:8214
```

`npm ci` builds automatically and downloads a roughly 567 MiB Desktop archive
on the **server computer**, not on the phone. Allow several minutes and about
5 GiB of free disk space for the build and installed snapshot. Both services
should report `active`; the connection probe should report `101`. Open
<http://127.0.0.1:8214>, then start a terminal session with
`~/.local/bin/codex-shared`. Keep using the original `codex` for standalone
sessions and account management.

For phone access on a trusted LAN, rerun the installer with
`--access lan --port 8214 --restart` and open `http://<computer-LAN-IP>:8214`.
See the Chinese guide for
[a computer/phone sharing check](docs/shared-sessions.zh-CN.md#4-验证电脑和手机是否共享同一会话),
[updates and service management](docs/shared-sessions.zh-CN.md#5-日常管理与更新),
and [common failures](docs/shared-sessions.zh-CN.md#常见问题).

## motivation

the agents were never meant to stay trapped in a terminal window for long.
codex desktop brought the power of agents to your local computer, where your
files, credentials, and tools already live.

codex-web brings codex desktop to the browser while keeping the backend on a
machine you control (a linux box in the cloud, your home lab, or a desktop / mac
mini). agents keep running after your laptop closes. you can reconnect from any
device with a browser.

this project aims to be as thin a wrapper as possible to ensure upstream changes
to the codex desktop app can be integrated quickly.

## standalone usage (without persistent shared services)

The commands in this section start a standalone Web backend. They do not install
`codex-shared` or the two Linux user services. Use the source installation above
for terminal/browser sharing. The same Node and build-tool prerequisites apply
to `npx`; it is not a prebuilt binary download.

`codex-web` serves the browser client and hosts the desktop-side bridge. by
default, it listens on `127.0.0.1:8214`.

it will use `codex` from `PATH` if available, or `CODEX_CLI_PATH` if you set
it.

run it with `npx`:

```bash
npx --yes github:0xcaff/codex-web
```

or with nix:

```bash
nix run github:0xcaff/codex-web
```

then open <http://127.0.0.1:8214> in a browser.

### sign in

ensure the codex cli on the host machine is signed in before starting the
server.

```bash
codex login --device-auth
```

### shared Linux sessions and LAN setup

Web and the `codex-shared` CLI can connect to the same long-lived app-server.
Restarting Web leaves that server and its sessions running. The installer creates
user services and a versioned snapshot; it retains the original `codex` command
and does not edit the global Codex configuration.

Requirements: Linux with `systemd --user`, Python 3, Node 22.12+, Codex CLI
0.160.1+, and `websocat` on `PATH`. Sign in to Codex first, then build and install
from a checkout:

```bash
git clone https://github.com/0xcaff/codex-web.git
cd codex-web
npm ci
python3 scripts/install-services.py --access local --restart
```

To allow a phone on the same trusted LAN, choose `--access lan` during installation:

```bash
python3 scripts/install-services.py --access lan --port 8214 --restart
```

Open `http://<computer-LAN-IP>:8214` on the phone. The Web server has no built-in
authentication; read the security section below before enabling LAN access.
The saved host and port are retained on subsequent installs when those flags
are omitted. `--host <IP>` selects a specific interface; `--dry-run` previews the
configuration without changing services.

Use `~/.local/bin/codex-shared` for a shared interactive session, or
`~/.local/bin/codex-shared resume <session-id>` to reopen one. Use the original
`codex` for login, plugins, and other standalone commands. Ordinary Desktop and
VS Code sessions remain independent unless explicitly attached to this server.

Desktop tools use the user's existing official `codex-app-tools` 0.1.5 plugin,
loaded from its installed cache. Supply another installation location with
`--app-tools /path/to/server.mjs`. Without it, shared sessions still work and the
orphan Desktop-only tool whitelist is removed locally. The plugin is not bundled
in this repository.

Already loaded CLI threads may retain their original tool configuration. Finish
the current turn, close its clients, and reopen it in Web, or create a new Web
thread to obtain Desktop tools. Those tools require an open, initialized Web tab.
This compatibility layer does not provide the unfinished browser/computer-use
features listed in the roadmap.

For a manually managed shared server:

```bash
node src/server/main.js --shared-socket /path/to/app.sock --host 127.0.0.1
```

The default mode still starts its own Codex process. Plain HTTP LAN pages and
runtime workers receive a UUID fallback backed by `crypto.getRandomValues`,
avoiding the blank page caused by missing `crypto.randomUUID` outside a secure
context. Browser features that require HTTPS still require HTTPS.

Run `npm test` for compatibility, installer, and supervisor checks.
`npm run test:install` exercises first installation and upgrades in a temporary
home with service commands intercepted. After a build,
`npm run test:integration` uses an isolated app-server and mobile-sized browser to
check real Desktop tool calls across a Web restart. It requires Google Chrome,
the official plugin, and signed-in Codex, and consumes some model quota. Set
`CODEX_TEST_CODEX`, `CODEX_TEST_BROWSER`, `CODEX_TEST_APP_TOOLS`,
`CODEX_TEST_HOST`, or `CODEX_TEST_PORT` to override test dependencies and address.
The integration test uses port 8220 by default and never restarts user services.

### mobile loading and reverse proxies

The build precompresses large webview assets with gzip and Brotli. The server
negotiates the supported representation and retains the original files as a
fallback. The browser IPC WebSocket also negotiates compression for large
messages; clients without compression remain supported. Compression preserves
the full session state and tool catalogs.

Large, identical IPC bodies are reused from a browser cache when refreshing the
same tab. The server reads the current state and compares SHA-256 hashes before
sending references; the browser validates and restores each original message.
Large bodies also reuse unchanged segments when only a small part changes.
Missing or damaged cache entries are
replayed in order, including subsequent updates and approvals. No history is
truncated, and the live app-server connection remains authoritative.

The cache uses IndexedDB, scoped to the browser tab and Web process, with a
one-hour expiry, a 64 MiB / 4,096-entry limit, and an 8 MiB limit per body. It stores
session data on the device; expired entries are pruned during later writes.
Clearing the site's browser storage removes it. Unavailable storage falls back
to memory or ordinary transfer. Set `CODEX_WEB_IPC_CACHE=0` in the Web process
environment to disable caching. First visits and changed content still require
downloads; savings depend on the conversation and how it is reopened.

HTTPS proxies must forward WebSocket upgrades for `/__backend/ipc`, retain that
path, and use HTTP/1.1 upstream. A regular HTTP 200 response to this endpoint can
leave the renderer on its startup logo even though all scripts have downloaded.
Check a deployment with:

```bash
node scripts/check-connection.cjs https://your-codex-domain.example
```

The expected result is `101`, followed by the negotiated compression extension.
See the [Nginx/frp example](docs/shared-sessions.zh-CN.md#nginx--frp-公网入口)
for proxy configuration and authentication requirements.

### proxying to app-server (advanced usage)

it’s often useful to run the app server separately, so a crash or restart of
codex-web doesn’t interrupt the codex process executing commands.

it's possible to hook codex-web up to an already-running app server using the
`codex_remote_proxy` script.

start a long-lived app server somewhere:

```bash
mkdir -p /tmp/codex-app-server
cd /tmp/codex-app-server
codex app-server --listen unix://codex-app-server.sock
```

then run `codex-web` with the proxy helper:

```bash
nix shell github:0xcaff/codex-web github:0xcaff/codex-web#codex_remote_proxy -c bash -lc '
  export CODEX_UNIX_SOCKET=/tmp/codex-app-server/codex-app-server.sock
  export CODEX_CLI_PATH="$(command -v codex_remote_proxy)"
  codex-web
'
```

`codex app-server proxy --sock ...` is a raw stdio protocol bridge for another
program to use; when run directly in a terminal it will wait for protocol input
rather than opening an interactive prompt.

## security

run `codex-web` only on trusted networks. treat anyone who can reach the
`codex-web` server as someone who can operate codex on the host machine as the
same user running the server.

if you need authn or authz, implement it outside of `codex-web`: proxy it through
wireguard, tailscale, or an ssh tunnel and put an authentication gateway or
reverse proxy in front.

someone with access to the web ui may be able to:

- run commands on the host, limited only by the permissions of the `codex-web`
  server process.
- read or modify files, environment variables, credentials, ssh keys, and other
  local resources that are accessible to that process.
- use the codex / chatgpt account already signed in on the host. this may
  consume usage quota or billing credits, and may expose account metadata shown
  by the app or cli, such as name or email address.

## features

- hostable on macOS, Linux (and anything codex cli + node will run on)
- reachable from the browser
- thin wrapper, so updates should land fast
- working today:
  - subagents
  - inline images
  - editor sidepanel
  - transcription

## roadmap

some parts of the desktop experience are not wired up yet:

- browser panel support, likely rebuilt around iframes
- computer use on linux, which could become a very powerful feature
- terminal support
- git worker integration
- whatever else people find and file issues for

## issues welcome

if something is broken, missing, or rough around the edges, please file an
issue.

using `codex-web` in an interesting way? post about it on x and tag me
[@0xcaff](https://x.com/0xcaff).

using this at a company and need something more tailored? email me and we can
talk.

## alternatives

- [davej/pocodex](https://github.com/davej/pocodex) i used this until the wheels fell off. i needed subagents
  and an inline image viewer. this didn't have them and was having a hard time
  keeping up with upstream codex updates.
- the native codex remote feature (behind a feature flag) is great for
  connecting to remote codex hosts over ssh to manage long running tasks but
  this only works if you have codex desktop on your client device. this means it
  doesn't work on mobile.
- upcoming first party mobile app from openai. `codex-web` exists and works
  today. i can't wait for the mobile app but judging by the other openai mobile
  apps, i'm a little bit skeptical about the quality of the mobile experience.
  time will tell.
