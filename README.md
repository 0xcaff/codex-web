# codex-web

a browser frontend for codex desktop, running on a machine you control.

## motivation

the agents were never meant to stay trapped in a terminal window for long.
codex desktop brought the power of the agents to your local computer, where
your files, credentials, and tools already live.

codex-web brings codex desktop to the browser while keeping the backend on a
machine you control (a linux box in the cloud, your home lab, or a desktop / mac
mini). agents keep running after your laptop closes, and you can reconnect from
any device with a browser.

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

it’s often useful to run the app server separately, so a crash or restart of
codex-web doesn’t interrupt the codex process executing commands.

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

## security

run `codex-web` only on a trusted network. treat anyone who can reach the
`codex-web` server as someone who can operate codex on the host machine as the
same user running the server.

if you need authn or authz, implement it outside of `codex-web`: proxy it through
wireguard, tailscale, or an ssh tunnel, or put an authentication gateway or
reverse proxy in front.

someone with access to the web ui may be able to:

- run commands on the host, limited only by the permissions of the `codex-web`
  server process.
- read or modify files, environment variables, credentials, ssh keys, and other
  local resources that are accessible to that process.
- use the codex / chatgpt account already signed in on the host. this may
  consume usage quota or billing credits, and may expose account metadata shown
  by the app or cli, such as name or email address.

## roadmap

some parts of the desktop experience are not wired up yet:

- terminal support
- git worker integration
- browser panel support, likely rebuilt around iframes
- computer use on linux, which could become a very powerful feature
- whatever else people find and file issues for

## issues welcome

if something is broken, missing, or rough around the edges, please file an
issue.

using `codex-web` in an interesting way? post about it on x and tag me
[@0xcaff](https://x.com/0xcaff).

using this at a company and need something more tailored? email me and we can
talk.

## alternatives

* [davej/pocodex](https://github.com/davej/pocodex) i used this until the wheels
  fell off for my needs. i needed subagents and inline image viewer and this
  didn't have it and also was having a hard time keeping up with upstream codex
  updates.
* the native codex remote feature (behind a feature flag) is great for
  connecting to remote codex hosts over ssh to manage long running tasks but
  this only works if you have codex desktop on your client device. this means it
  doesn't work on mobile.
* upcoming first party mobile app from openai. this exists and works today. i
  can't wait for the mobile app but judging by the other openai mobile apps, idk
  how buggy they will be. time will tell.
