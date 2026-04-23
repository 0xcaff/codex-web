---
name: update codex web
description: update codex-web to a specific upstream codex desktop app version
---

# workflow

use this skill when updating `codex-web` to a new upstream codex desktop app build.

## preparing devshell

first, update `appVersion` in `default.nix` to the specified version. next, run
`DEV=1 nix develop --command yarn prepare:asar`. on the first run there will be
a hash mismatch, fix it and proceed. this will download the app and extract it.
it will likely fail to patch as patches haven't been updated yet.

also udpate the url in `./scripts/prepare`

## migrate patches

patches will likely fail in `prepare:asar`. in this case, do the following for
each failed patch

1. copy the target file being patched to a temp folder

2. look at the existing patch, make changes to the target file in `./scratch`
    until you have the desired behavior (see valiation steps below)

3. generate a new patch by diffing the original file backed up earlier to the
   file modified in scratch

### guidelines

- update only the patch context and filenames needed for the new upstream
  bundle.

- keep local behavior changes intact; do not broaden patches unless the
  upstream code requires it.

finaly, after updating all patches run `DEV=1 nix develop --command yarn
prepare:asar` to validate all patches apply.

## updating codex cli version

the codex app version uses a specific version of the codex cli. we need to find
it and update our references.

if you're running on a darwin-aarch64 target, find the version by running

```bash
scratch/Codex.app/Contents/Resources/codex --version
```

and pin the matching cli version exactly

```bash
nix develop --command yarn add --dev --exact @openai/codex@<cli-version>
```

update `cliVersion` in `default.nix` to the same version.

### refreshing lockfile hash

when `yarn.lock` changes, refresh `fetchYarnDeps.hash`.

1. temporarily set the hash in `default.nix`.

   ```nix
   hash = pkgs.lib.fakeHash;
   ```

2. build and copy the `got: sha256-...` value from the expected hash mismatch.

   ```bash
   nix build .#default --no-link
   ```

3. replace `pkgs.lib.fakeHash` with the `got` hash and rebuild.

   ```bash
   nix build .#default --no-link
   ```

## validation

run the local server on a spare port and confirm startup reaches a connected
app-server state.

```bash
yarn server --host 127.0.0.1 --port 8220
```

expected evidence in logs:

- `stdio_transport_spawned` uses `node_modules/.bin/codex`.
- `current reported app-server version` matches the pinned cli.
- `codex-app-server-initialized` reports the same `appServerVersion`.

stop the test process after verification.
