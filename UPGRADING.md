# upgrading

instructions for upgrading codex-web to point at a new version of upstream
Codex Desktop.

## backing up

we will start by generating a scratch directory and backing it up. first, let's
get the `scratch` directory to a known state by running the following

```bash
rm -rf scratch scratch-backup # remove existing past scratch directories to start from clean state
DEV=1 nix develop --command yarn run prepare:asar 
mv scratch scratch-backup
```

the `scratch-backup` directory holds the patched, working version of codex-web.
we will use this when moving the patches over to the new version to understand
the context the patches were being applied in.

## updating urls

there are a few places to update next.

1. `appVersion` in default.nix and `hash` in `codexZip`.
2. `APP_VERSION` in ./scripts/prepare
3. The Chromium version in `ensureElectronLikeProcessContext` in
   `src/server/main.ts`, matching the version under
   `ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/`.
4. `PWA_SOURCE_ICON` in `scripts/prepare_asar` if the upstream icon filename changed.

then temporarily comment out the patch lines in ./scripts/prepare_asar and run

```bash
DEV=1 nix develop --command yarn run prepare:asar 
cp -r scratch scratch-new-version-unmodified
```

## upgrading the codex-cli version

this part can be run concurrently with the rest of the upgrade process. make
sure to wait for its completion before doing validation. run it in a subagent.

run the following to get the version of the new codex-cli

```bash
scratch/ChatGPT.app/Contents/Resources/codex-cli/bin/codex --version
```

then update the `nix/codex/default.nix` file's `version` field and hashes to
point to the new version.

## porting over patches

now we have a few folders

* `scratch-backup`: patches applied on top of old version of Codex Desktop
* `scratch-new-version-unmodified`: plain extracted new version of Codex Desktop
* `scratch`: working copy we will be modifying

now carefully look at the patches in `patches/` and how they were applied in
`scratch-backup` and bring the changes over to `scratch`. apply them directly
in-tree first. don't worry immediately about updating the patches yet.

## updating patches

once the patches have been made in `scratch`, diff the changes in `scratch`
against `scratch-new-version-unmodified` and update the patches in `patches/`.
always generate the patches by running `diff` and always avoid writing the
patches manually as it's very easy to get them wrong.

once that is done, uncomment the patch lines in `scripts/prepare_asar` and run

```bash
mv scratch scratch-patched-inplace
rm -rf scratch
DEV=1 nix develop --command yarn run prepare:asar 
```

then diff `./scratch-patched-inplace` with the resulting `./scratch` to validate
the patches were applied as expected.

## validation

to validate things are still working, we'll first validate the server, then the
client. before starting this step, make sure to wait for the
`upgrading the codex-cli version` subagent to finish.

first check the runtime and build both the package and development server:

```bash
nix develop --command node -p 'process.version + " DisposableStack=" + typeof DisposableStack'
nix build
nix flake check
nix develop --command yarn server
```

Node must be 24 or newer and `DisposableStack` must be `function`. Keep the
Nix development shell, package builder, native better-sqlite3 addon, and launch
wrapper on the same Node version. A successful build alone does not validate
upstream runtime requirements.

open `http://localhost:8214` in a real browser. Use a disposable local Git
project and test profile so validation does not alter existing chats or files.
Validate the built package too if it uses a different launch path.

* Select the local project and verify it appears in the sidebar.
* Submit a prompt that reads a file and runs a harmless command. Wait for the
  tool results and a completed response; typing a draft is not sufficient.
* Send a follow-up in that chat. Have it change a disposable file and verify
  the change appears in the diff panel. Check the branch picker and Git status.
* Reload, reopen the chat from history, and confirm the messages and project
  selection persist. Check the composer at a narrow viewport as well.
* If the CLI proxy changed, validate startup-config output and a complete
  request/response through a real proxied app-server connection.

check both the browser console and server logs throughout. Look for error
notifications and operations stuck loading for over one minute. Record the
checks actually performed and any unresolved failures. Do not declare the
upgrade validated while message submission or Git operations are failing.

bring errors to the user's attention and resolve them within the authorized
scope before publishing the upgrade.
