# architecture

a bit on how this whole thing is put together.

the general approach here is to download the electron app, unpack it and apply
as small a set of patches to it as possible to get it working.

an electron app has two parts, a part which runs in the main process and a part
which runs in the renderer process.

the main process part is basically a node process with a `require('electron')`
dependency. it runs even before anything is visible on the screen, setting up
the system tray widget, running background tasks and hooking up listeners for
app launcher events. there is a single instance of the main process regardless
of how many windows are open.

the ui runs inside an electron renderer process. in the desktop app, this looks
sorta like a browser with some modifications to the browser's chrome. it handles
displaying the interface, reacting to events from user interaction and holding
onto state which lives close to the ui (what text is in the prompt box for
example).

the electron renderer process usually launched by the electron main process. the
main process and render process communicate via an IPC setup in a [preload
script]. the preload script is injected into the renderer process before
anything else loads, has privileged access and can expose functions and data to
the renderer realm through `contextBridge.exposeInMainWorld`. the preload script
has access to [`ipcRenderer`].

codex-web hooks the preload script by providing [shim.ts](./src/browser/shim.ts)
as a stand-in for electron in the renderer process and then setting up preload
to run in the renderer realm (see
[vite.browser.config.ts](./vite.browser.config.ts)).

next, we apply a series of patches to both code running in the main process and
the renderer process. these are applied at postinstall time through the
[`prepare_asar`](./scripts/prepare_asar) script. patches are located
in [./patches](./patches) and applied ontop of the prettified code extracted
from the upstream app. care was taken here to patch at installation time to
avoid redistributing the original code.
the [./patches/webview-preload.patch](patches/webview-preload.patch) connects
the shimmed preload script to the index.html entrypoint.

we aim for the patches to be as small as possible as they're the most annoying
part to change. the patches today are mostly around routing, urls, page title,
pwa and mobile behavior.

to connect the ipc from the renderer process to the main process, we use a
websocket for most messages intercepting and handing a small handful of messages
directly (file picker, workspace picker). today, the remaining parts of shim are
for connecting the in memory router to the browser history and setting up the
sidebar behavior on mobile.

the ipc websocket is hosted by [main.ts](./src/server/main.ts). this process
binds a port and listens for incoming websocket connections. it also shims
electron (see `installModuleAliasHook`) before loading the electron shell
entrypoint. the shims are located in
[./src/server/electron](./src/server/electron) and focus on providing the
minimum amount of functionality needed to make the app work. this comes down to
some network transport to the outside world and hooking up to the ipc pipe from
the renderer. this part is the most sloppy part of the codebase as i left codex
to figure it out unattended. the parts around `__codexElectronIpcBridge` are the
important bits related to wiring up the ipc bridge.

[preload script]: https://www.electronjs.org/docs/latest/tutorial/tutorial-preload
[`ipcRenderer`]: https://www.electronjs.org/docs/latest/api/ipc-renderer
