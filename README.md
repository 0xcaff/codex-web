# codex-web

host codex desktop on a machine you control and reach it from a browser.

## motivation

the agents were never meant to stay trapped in a terminal window for long.
codex desktop brought the power of the agents to your local computer, where
your files, credentials and tools already live.

codex-web brings codex desktop to the browser while keeping the backend on a
machine you control (a linux box in the cloud, your home lab, or a desktop / mac
mini). agents keep running after your laptop closes, and you can reconnect from
mobile or any browser-capable device.

this project aims to be as thin a wrapper as possible to ensure upstream changes
to the codex desktop app can be integrated quickly.

## features

- can host on linux or macos
- reachable from the browser
- thin wrapper, so updates should stay fast and most desktop behavior already
  comes along for the ride
- working today:
  - subagents
  - inline images
  - editor sidepanel
  - transcription

## usage

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

### proxying to app-server (advanced usage)

it is often desirable to run app server separately and use `codex-web` as one
of many frontends to a long-lived app server decoupled from the lifespan of any
client (in case, for example, the client crashes)

it's possible to hook codex-web up to an already-running app server using the
`codex_remote_proxy` script.

start a long-lived app server somewhere:

```bash
codex app-server --listen ws://127.0.0.1:9001
# reachable now with `codex --remote  ws://127.0.0.1:9001` then `/resume`
```

then run `codex-web` with the proxy helper:

```bash
nix shell github:0xcaff/codex-web github:0xcaff/codex-web#codex_remote_proxy -c bash -lc '
  export CODEX_REMOTE_WS_URL=ws://127.0.0.1:9001
  export CODEX_CLI_PATH="$(command -v codex_remote_proxy)"
  codex-web
'
```

## non-features

this project is meant to stay small and scrappy. the focus is on wrapping the
codex app as simply as possible.

- built-in auth. put it behind a reverse proxy like caddy.
- direct exposure to the public internet. use tailscale or roll your own
  wireguard if you want to reach it outside your lan.

## broken but want to fix

- terminal
- git worker is not hooked up yet
- browser panel, which might be possible to rebuild around iframes
- probably more (file an issue please)

## issues welcome

is there something broken you'd like to see fixed? file an issue!

using this in an interesting way and want to share? post on X and tag me
(@0xcaff).

using this at a company and need something more than offered here? send me an
email and we can talk.
