# codex-web

Use Codex Desktop’s browser UI from a browser while its Codex process, files,
and credentials remain on a machine you control.

`codex-web` is a host-capability service, not an authentication boundary. It is
best used on loopback, or behind a private network you already trust.

## Choose an operator journey

| Need                                     | Recommended connection                              |
| ---------------------------------------- | --------------------------------------------------- |
| Browser on the same host                 | Default loopback listener                           |
| A device on a trusted home or office LAN | `--lan`                                             |
| A personal remote device                 | Tailscale, WireGuard, or SSH forwarding             |
| A named HTTPS endpoint                   | A reverse proxy that handles TLS and access control |

Do not put the service directly on a public interface. codex-web does **not**
provide authentication or TLS.

## Prerequisites

- A supported macOS or Linux host. The host needs the Codex CLI and a signed-in
  Codex account.
- A browser device that can reach the host using one of the trusted paths below.
- For the Nix route, Nix with flakes enabled. It provides the pinned runtime and
  is the recommended first run.
- For the `npx` route, Node.js/npm, a C/C++ build toolchain and Python for the
  native dependency, plus network access to npm, GitHub, and the upstream
  Codex Desktop download. The first run builds the package locally.

Sign in on the **host** before starting the server:

```bash
codex login --device-auth
# → completes device sign-in on this host
```

## Recommended: Nix first run

Nix packages the pinned Codex CLI and avoids relying on a workstation-global
Node installation:

```bash
nix run github:0xcaff/codex-web
# → codex-web listening at http://127.0.0.1:8214
```

Open <http://127.0.0.1:8214> on the same host. The default listener is
`127.0.0.1:8214`; it is deliberately not reachable from the LAN.

For a local development checkout, install dependencies and run the same
loopback-safe server:

```bash
npm ci
npm run server
# → codex-web listening at http://127.0.0.1:8214
```

The `npx` route is convenient when its first-build requirements are acceptable:

```bash
npx --yes github:0xcaff/codex-web
# → codex-web listening at http://127.0.0.1:8214
```

## Trusted LAN

Use `--lan` only for a network where every reachable client is trusted. It is
an explicit alias for `--host 0.0.0.0`; it cannot be combined with `--host`.

```bash
nix run github:0xcaff/codex-web -- --lan
# → prints non-loopback IPv4/IPv6 candidate URLs and a TRUSTED NETWORK WARNING
```

The startup report lists only non-internal IPv4 and IPv6 interface addresses;
IPv6 URLs are correctly bracketed. They are candidates to check against the
host’s routing and firewall policy. `--lan` binds the IPv4 wildcard address.

The browser UI is equivalent to giving a user access to Codex running as the
server account. Anyone who can reach it may run commands, read or modify files
and environment variables available to that account, use its credentials (such
as SSH keys), and consume its signed-in Codex account’s usage or billing quota.
Run it as a dedicated unprivileged user with only the files and credentials it
actually needs. Do not run it as root and do not share a LAN listener with
untrusted guests.

## Private remote access

### Tailscale or WireGuard

Prefer binding the service to the VPN address, rather than all LAN interfaces:

```bash
nix run github:0xcaff/codex-web -- --host 100.64.0.10
# → codex-web listening at http://100.64.0.10:8214
```

Replace `100.64.0.10` with the host’s private VPN address and restrict VPN ACLs
to the people and devices allowed to operate that host. The browser’s exact
same-origin WebSocket connection works when it opens that same URL.

### SSH forwarding

Leave the server on loopback and forward it from the client machine:

```bash
ssh -N -L 8214:127.0.0.1:8214 codex-host.example
# → remains connected while forwarding client localhost:8214 to the host
```

Then browse to <http://127.0.0.1:8214> on the client. This is often the
simplest safe route when you already manage SSH access.

## Reverse proxy and a named HTTPS origin

Keep codex-web bound to loopback and let the proxy terminate TLS and enforce
authentication. The proxy must forward both regular HTTP and the IPC WebSocket
at `/__backend/ipc`:

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
header. If the external origin differs from the Host passed upstream, start the
server with an explicit, repeatable `--allowed-origin` for every exact external
HTTP(S) origin; wildcards, paths, credentials, and query strings are rejected.

```bash
nix run github:0xcaff/codex-web -- \
  --allowed-origin https://codex.example.com \
  --allowed-origin https://codex-admin.example.com
# → codex-web remains on 127.0.0.1:8214 with only those additional origins allowed
```

`--allowed-origin` is an origin check, not authentication and not TLS. Put
access control, TLS certificates, rate limits, and network policy in the proxy
or private network.

## Uploads and disconnects

Uploads go to a private, server-owned temporary directory. Defaults are 25 MiB
per file, 32 files, and 100 MiB total per request. Completed upload directories
are scavenged after 24 hours on a later server start. Set finite overrides with
`--upload-max-file-bytes`, `--upload-max-files`,
`--upload-max-aggregate-bytes`, and `--upload-retention-ms`, or their
`CODEX_WEB_UPLOAD_*` environment-variable equivalents.

Closing a browser tab disconnects its WebSocket. It does not grant an automatic
reconnect to a previous renderer session, and it does not necessarily stop a
Codex operation already running on the host. Reopen the URL to establish a new
browser connection; use the advanced app-server setup below when Codex itself
must outlive codex-web restarts.

## Advanced: a separate long-lived app server

Normally codex-web starts Codex as its child. This is the right default: the
child lifecycle, readiness, and shutdown follow codex-web, and there is less to
operate.

Use a separate app server only when you deliberately need Codex work to survive
a codex-web restart. Start it under the same dedicated service user and make
the Unix socket private to that user:

```bash
install -d -m 700 /var/lib/codex-web/app-server
codex app-server --listen unix:///var/lib/codex-web/app-server/codex.sock
# → a long-lived app-server listening on a Unix socket, not TCP
```

The helper below maps the stdio protocol codex-web expects to that Unix socket
through `websocat`. It does not create a TCP listener, and the socket directory
permissions are part of the security boundary:

```bash
nix shell github:0xcaff/codex-web github:0xcaff/codex-web#codex_remote_proxy -c bash -lc '
  export CODEX_UNIX_SOCKET=/var/lib/codex-web/app-server/codex.sock
  export CODEX_CLI_PATH="$(command -v codex_remote_proxy)"
  exec codex-web
'
# → codex-web connects to the existing Unix-socket app server through websocat
```

Start the app server before the bridge. If the app server stops, restart it and
then restart the bridge so it reconnects cleanly; check that the socket exists
and is owned by the dedicated user before restarting. Shut down in reverse
order: stop codex-web, then stop the app server. Do not run the raw
`codex app-server proxy --sock ...` command in a terminal expecting a prompt:
it is a noninteractive stdio protocol bridge for another program.

## Troubleshooting

- **The page does not open:** verify the startup URL, listener, firewall, and
  VPN/SSH route. Keep the default loopback listener for SSH forwarding.
- **The page loads but Codex actions fail:** run `codex login --device-auth` as
  the same service user, and ensure `codex` or `CODEX_CLI_PATH` is available to
  codex-web.
- **WebSocket disconnects behind a proxy:** proxy `/__backend/ipc` with HTTP/1.1
  Upgrade headers and preserve the browser-facing Host. Configure each differing
  external origin with `--allowed-origin`.
- **LAN URL is missing:** the report intentionally omits loopback and internal
  interfaces. Check the host network address and firewall; do not guess from a
  Docker-only address.
- **Uploads are rejected:** reduce request size/count or raise the finite upload
  limits deliberately. Check temporary-disk capacity as well.

## Development checks

```bash
npm run check
# → type checks, Vitest suite, proxy argument-flow test, and formatting check pass
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the build, runtime, and trust
boundaries, and [UPGRADING.md](UPGRADING.md) for upstream Codex Desktop update
gates.
