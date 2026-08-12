# codex-web

Use Codex Desktop’s browser UI from a browser while the Codex process, files,
and credentials stay on a machine you control.

`codex-web` is a host-capability service, not an authentication boundary. Keep
it on loopback by default, or place it only on a network you already trust.

## Start from this checkout

The commands in this section use the repository you are currently in. They are
the right path while testing local changes or an unmerged branch.

Prerequisites: a supported macOS or Linux host, a signed-in Codex CLI, and a
current Node.js/npm installation with the native-build prerequisites required by
`better-sqlite3` (Python and a C/C++ compiler). Sign in as the same host user
that will run the service:

```bash
codex login --device-auth
# → completes device sign-in on this host

npm ci
# → downloads, verifies, extracts, and patches the pinned Desktop archive, then builds local artifacts

npm run server
# → codex-web listening at http://127.0.0.1:8214
```

Open <http://127.0.0.1:8214> on the same host. `npm run server` deliberately
starts from the already-built artifacts: it does not silently rebuild or
precompress the browser bundle. Use `npm run rebuild` when you intentionally
want to rebuild those artifacts; it prints progress while precompressing the
extracted Desktop bundle. `npm run server:rebuild` performs that explicit
rebuild before starting.

`npm ci` verifies the non-Nix Desktop download against the pinned SHA-256 before
extraction. Do not bypass that check or substitute an unpinned archive.

## Operator commands

| Command                         | Purpose                                                                     |
| ------------------------------- | --------------------------------------------------------------------------- |
| `npm run server`                | Start the existing local build on loopback (`127.0.0.1:8214`).              |
| `npm run server -- --port 9000` | Start on a chosen port.                                                     |
| `npm run server:lan`            | Bind `0.0.0.0` for a trusted LAN and print IPv4 URLs.                       |
| `npm run rebuild`               | Rebuild server/browser artifacts from the existing extracted Desktop files. |
| `npm run server:rebuild`        | Rebuild, then start the loopback server.                                    |
| `npm run help`                  | Print this short command reference in the terminal.                         |

The default loopback listener is intentionally not reachable from the LAN.

## Trusted LAN

Use `--lan` only for a network where every reachable client is trusted. It is
an explicit alias for `--host 0.0.0.0`; it cannot be combined with `--host`.

```bash
npm run server:lan
# → prints non-loopback IPv4 candidate URLs and a TRUSTED NETWORK WARNING
```

Because `--lan` binds the IPv4 wildcard address, the startup report lists only
non-internal IPv4 interface addresses that can reach that listener. They are
candidates to check against the host’s routing and firewall policy.

The browser UI is equivalent to giving a user access to Codex running as the
server account. Anyone who can reach it may run commands, read or modify files
and environment variables available to that account, use its credentials (such
as SSH keys), and consume its signed-in Codex account’s usage or billing quota.
Run it as a dedicated unprivileged user with only the files and credentials it
needs. Do not run it as root and do not share a LAN listener with untrusted
guests.

## Private remote access

### Tailscale or WireGuard

Prefer binding directly to the VPN address rather than every LAN interface:

```bash
npm run server -- --host 100.64.0.10
# → codex-web listening at http://100.64.0.10:8214
```

Replace `100.64.0.10` with the host’s private VPN address and restrict VPN ACLs
to the people and devices permitted to operate that host.

### SSH forwarding

Leave the service on loopback and forward it from the client machine:

```bash
ssh -N -L 8214:127.0.0.1:8214 codex-host.example
# → stays connected while forwarding client localhost:8214 to the host
```

Then browse to <http://127.0.0.1:8214> on the client.

## Reverse proxy and named HTTPS origin

Keep codex-web bound to loopback and let the proxy terminate TLS and enforce
authentication. It must forward regular HTTP and the IPC WebSocket at
`/__backend/ipc`:

```nginx
location / {
  proxy_pass http://127.0.0.1:8214;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location /__backend/ipc {
  proxy_pass http://127.0.0.1:8214;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

The IPC bridge accepts an exact browser origin that matches the received `Host`
header. If the external origin differs from the Host passed upstream, add each
exact external HTTP(S) origin with `--allowed-origin`; wildcards, paths,
credentials, and query strings are rejected.

```bash
npm run server -- \
  --allowed-origin https://codex.example.com \
  --allowed-origin https://codex-admin.example.com
# → stays on loopback with only those additional browser origins allowed
```

`--allowed-origin` is not authentication or TLS. Put access control,
certificates, rate limits, and network policy in the proxy or private network.

## Uploads and disconnects

Uploads go to a private, server-owned temporary directory. Defaults are 25 MiB
per file, 32 files, and 100 MiB total per request. Completed upload directories
are scavenged after 24 hours on a later server start. Set finite overrides with
`--upload-max-file-bytes`, `--upload-max-files`,
`--upload-max-aggregate-bytes`, and `--upload-retention-ms`, or their
`CODEX_WEB_UPLOAD_*` environment-variable equivalents.

Closing a browser tab disconnects its WebSocket. It does not necessarily stop a
Codex operation already running on the host. Reopen the URL to establish a new
browser connection; use the advanced app-server setup below when Codex itself
must outlive codex-web restarts.

## Advanced: a separate long-lived app server

Normally codex-web starts Codex as its child. This is the right default: child
lifecycle, readiness, and shutdown follow codex-web, and there is less to
operate.

Use a separate app server only when you deliberately need Codex work to survive
a codex-web restart. Start it under the same dedicated service user and make
the Unix socket private to that user:

```bash
install -d -m 700 /var/lib/codex-web/app-server
codex app-server --listen unix:///var/lib/codex-web/app-server/codex.sock
# → a long-lived app-server listening on a Unix socket, not TCP
```

codex-web expects a stdio protocol, whereas this app server exposes a Unix
socket. `scripts/codex_remote_proxy` bridges those two transports through
`websocat`; it does not open a TCP listener. Socket-directory permissions are
therefore part of the security boundary.

For a non-Nix local checkout, install `websocat` on the host and run:

```bash
export CODEX_UNIX_SOCKET=/var/lib/codex-web/app-server/codex.sock
export CODEX_CLI_PATH="$PWD/scripts/codex_remote_proxy"
npm run server
# → codex-web connects to the existing Unix-socket app server through websocat
```

For the same local checkout with Nix, use the pinned Codex CLI and proxy helper:

```bash
nix shell .#codex .#codex_remote_proxy -c bash -lc '
  export CODEX_UNIX_SOCKET=/var/lib/codex-web/app-server/codex.sock
  export CODEX_CLI_PATH="$(command -v codex_remote_proxy)"
  exec nix run .
'
# → codex-web connects to the existing Unix-socket app server through websocat
```

Start the app server before the bridge. If it stops, restart it and then restart
the bridge so it reconnects cleanly; verify that the socket exists and is owned
by the dedicated user first. Shut down in reverse order: stop codex-web, then
stop the app server. Do not run the raw `codex app-server proxy --sock ...`
command in a terminal expecting a prompt: it is a noninteractive stdio bridge
for another program.

## Optional Nix packaging

Nix is optional for normal local operation. This repository’s flake pins a
reproducible Node/build environment, Codex Desktop archive, native
`better-sqlite3` build, Codex CLI, and the app-server proxy helper. From this
checkout, `nix run .` runs the local revision:

```bash
nix run .
# → runs the codex-web package built from this checkout
```

`nix run github:0xcaff/codex-web` and `npx github:0xcaff/codex-web` are
published-upstream commands. They fetch the repository revision named in the
reference (currently its published default branch), not uncommitted or
unpublished changes in this checkout. Use them only after the desired revision
has been pushed or tagged.

## Troubleshooting

- **The page does not open:** verify the startup URL, listener, firewall, and
  VPN/SSH route. Keep the default loopback listener for SSH forwarding.
- **The page loads but Codex actions fail:** run `codex login --device-auth` as
  the same service user, and ensure `codex` or `CODEX_CLI_PATH` is available.
- **The process appears stuck before listening:** use `npm run server`, not a
  rebuild command. `npm run rebuild` intentionally precompresses the upstream
  webview and prints its progress.
- **WebSocket disconnects behind a proxy:** proxy `/__backend/ipc` with HTTP/1.1
  Upgrade headers and preserve the browser-facing Host. Configure each differing
  external origin with `--allowed-origin`.
- **LAN URL is missing:** the report omits loopback/internal interfaces. Check
  the host network address and firewall; do not guess from a Docker-only address.
- **Uploads are rejected:** reduce request size/count or raise the finite limits
  deliberately. Check temporary-disk capacity as well.
- **Need bridge tracing:** use `CODEX_WEB_DEBUG=1 npm run server`. Trace output
  is shape-only: it omits argument values and bounds payload summaries. Raw
  upstream console output remains suppressed because it can contain request
  bodies, settings, account data, credentials, and local paths.

## Maintainer checks

```bash
npm run check
# → type checks, Vitest suite, proxy argument-flow test, and formatting check pass
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full script reference,
[ARCHITECTURE.md](ARCHITECTURE.md) for trust/build boundaries, and
[UPGRADING.md](UPGRADING.md) for upstream Desktop update gates.
