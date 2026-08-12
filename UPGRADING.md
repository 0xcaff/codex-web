# Upgrading Codex Desktop

This repository carries a pinned upstream Codex Desktop archive plus a small
set of patches. Treat an upgrade as a compatibility exercise: preserve a known
good extracted copy, port each patch intentionally, then pass server and browser
gates before publishing a new build.

## Prerequisites and safe workspace

- Use a clean worktree with enough disk space for several extracted app copies.
- Use the Nix development environment for the pinned CLI, Node, unzip, and
  patch tools. `nix develop` is the reproducible route.
- An npm-only workflow also needs Node.js/npm, Python, a C/C++ build toolchain,
  and network access for the initial native-dependency build. Run `npm ci`
  before its checks.
- Back up an existing `scratch/` directory outside the repository before any
  destructive preparation command. The commands below replace `scratch/`.

Check the current formatting and test baseline first:

```bash
nix develop --command npm run check
# → type checks, tests, proxy test, and formatting pass
```

## 1. Update the pinned archive

Update the archive version and hash in `default.nix`, and keep
`scripts/prepare`’s `APP_VERSION` in sync. Update `nix/codex/default.nix` when
the bundled Codex CLI version changes.

Confirm the flake still evaluates before downloading or extracting anything:

```bash
nix flake check --no-build
# → evaluates flake checks without building packages
```

## 2. Preserve the known-good extraction

With a reviewed backup location chosen by the operator, prepare the current
version and move it aside. This intentionally replaces the repository’s
`scratch/` directory:

```bash
DEV=1 nix develop --command npm run prepare:asar
mv scratch scratch-backup
# → scratch-backup contains the known-good patched extraction
```

For the new upstream version, temporarily disable patch application in
`scripts/prepare_asar`, then extract its unmodified tree:

```bash
DEV=1 nix develop --command npm run prepare:asar
mv scratch scratch-new-version-unmodified
# → scratch-new-version-unmodified contains the new unpatched tree
```

## 3. Port and regenerate patches

Compare `scratch-backup`, `scratch-new-version-unmodified`, and the current
`patches/` entries. Apply the required changes to a fresh `scratch/` copy first.
Generate patch files with `diff`; do not hand-edit large generated patches.

Re-enable the patch lines and regenerate:

```bash
DEV=1 nix develop --command npm run prepare:asar
# → scratch/ contains the newly extracted, patched application
```

Inspect the generated diff against the unmodified extraction. Every changed
upstream file needs a corresponding intentional patch or documented reason.

## 4. Validate package, server, and browser/mobile behavior

Run the full npm gate twice. The repeated run catches build products or ordering
issues hidden by a warm first run:

```bash
npm run check
npm run check
# → both runs pass typecheck, Vitest, proxy argument-flow, and formatting
```

Run the reproducible Nix gate as well:

```bash
nix develop --command npm run check
# → the same check passes in the Nix development environment
```

Start the server on loopback, open <http://127.0.0.1:8214>, and verify in a
desktop browser and a narrow mobile viewport:

- the app reaches a ready state without console errors or silent loading beyond
  one minute;
- a new browser tab can connect, an IPC-backed action completes, and a tab
  disconnect/reconnect behaves predictably;
- a bounded upload works and an oversized upload is rejected;
- mobile navigation, focus, and touch-sized controls remain usable;
- a reverse-proxy deployment upgrades `/__backend/ipc` to WebSocket and has the
  right exact external `--allowed-origin` entries when the upstream Host differs.

Do not claim that codex-web supplies TLS or authentication during this process;
those remain reverse-proxy or private-network responsibilities.
