# macOS Cloudflare operations guide

This guide runs `codex-web` as a loopback-only macOS service and publishes one
exact hostname through a dedicated Cloudflare Tunnel. Cloudflare Access is the
authentication boundary.

Anyone who passes the Access policy can operate Codex with the permissions of
the macOS user running `codex-web`. Treat the deployment as remote shell access.

## Required security shape

- Keep `codex-web` bound to `127.0.0.1`; do not bind it to a LAN or public
  interface.
- Set `CODEX_WEB_ALLOWED_ORIGINS` to the exact public HTTPS origin.
- Restrict `CODEX_WEB_WORKSPACE_ROOTS` and `CODEX_WEB_FILE_ROOTS` to the
  directories the browser should enumerate or render.
- Create the Cloudflare Access application before publishing the tunnel route.
- Use a dedicated tunnel and an exact hostname, not a wildcard.
- Enable **Enforce Access JSON Web Token (JWT) validation** on the published
  application route and select the matching Access application.
- Store the tunnel token in macOS Keychain or another secret store. Do not put
  it in the repository, a shell profile, or a LaunchAgent plist.

The workspace and file roots constrain browser-facing navigation. They do not
reduce the filesystem or command permissions of the Codex backend.

## Recommended setup order

1. Build and test `codex-web` locally, then verify it listens only on
   `127.0.0.1:8214`.
2. Create a self-hosted Cloudflare Access application for the exact public
   hostname. Add the narrowest possible allow policy and select only the
   intended identity provider.
3. Create a dedicated remotely managed Cloudflare Tunnel.
4. Install `cloudflared` and run its connector as the same macOS login user.
5. Add one published application route from the exact hostname to
   `http://127.0.0.1:8214`.
6. In the route's Access origin settings, require Access JWT validation and
   select the Access application from step 2.
7. Verify an unauthenticated request is redirected to Access, an authorized
   browser session loads the application, and the origin remains loopback-only.

Creating the published application route automatically creates the exact DNS
mapping managed by Cloudflare. It does not require manually editing an existing
wildcard record, and the exact hostname takes precedence over a wildcard.

## Persistent macOS services

Use two user LaunchAgents so the application and connector can be controlled
independently:

- one LaunchAgent runs Node with `src/server/main.js` and the required
  `CODEX_WEB_*` environment variables;
- one LaunchAgent runs `cloudflared tunnel run`, obtaining its token from
  Keychain through a small owner-only wrapper script.

Give the plist and wrapper files permissions of `600` and `700`, respectively.
Use stable labels such as `com.example.codex-web` and
`com.example.cloudflared.codex-web`.

Load them in origin-first order:

```bash
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.example.codex-web.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.example.cloudflared.codex-web.plist"
```

## Status and verification

```bash
launchctl print "gui/$(id -u)/com.example.codex-web"
launchctl print "gui/$(id -u)/com.example.cloudflared.codex-web"
lsof -nP -iTCP:8214 -sTCP:LISTEN
curl -I https://codex.example.com
```

Expected results:

- both LaunchAgents report `state = running`;
- the only listener on port 8214 is `127.0.0.1:8214`;
- an unauthenticated public request returns a redirect to the Cloudflare Access
  team domain;
- the tunnel dashboard reports a healthy connector and one exact published
  application route.

## Stop and restart

To make the public service unavailable while keeping the local application
running, stop only the tunnel connector:

```bash
launchctl bootout "gui/$(id -u)/com.example.cloudflared.codex-web"
```

To stop everything, stop the tunnel first and the origin second:

```bash
launchctl bootout "gui/$(id -u)/com.example.cloudflared.codex-web"
launchctl bootout "gui/$(id -u)/com.example.codex-web"
```

Restart in the opposite order:

```bash
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.example.codex-web.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.example.cloudflared.codex-web.plist"
```

## Complete removal

1. Stop both LaunchAgents.
2. In Cloudflare, remove the exact published application route, delete its
   dedicated tunnel, and delete the matching Access application. Verify the
   exact DNS mapping is gone before changing any wildcard route.
3. Delete the two LaunchAgent plists and the cloudflared wrapper.
4. Delete the tunnel token from the chosen secret store.
5. Optionally uninstall `cloudflared` only if no other local tunnel uses it.
6. Keep or delete the repository and logs separately; they are not required for
   Cloudflare cleanup.

Removing the Access application alone is not a complete shutdown. Stop the
connector first so an accidental policy or routing change cannot expose the
origin during cleanup.
