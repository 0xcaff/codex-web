const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  BrowserWindow,
  dialog,
  ipcMain,
} = require("../src/server/electron/index.js");

test("folder dialog returns one browser-selected source folder", async () => {
  const window = new BrowserWindow();
  const bridge = globalThis.__codexElectronIpcBridge;
  const previousSend = bridge.sendToRenderer;

  try {
    bridge.sendToRenderer = (webContentsId, message) => {
      assert.equal(webContentsId, window.webContents.id);
      assert.equal(message.channel, "codex-web:open-directory-dialog");
      const [requestId, options] = message.args;
      assert.equal(options.allowMultiple, true);
      queueMicrotask(() => {
        bridge.handleRendererSend(
          "codex-web:directory-dialog-result",
          [requestId, ["/home/example/project-a"]],
          window.id,
        );
      });
    };

    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "multiSelections"],
      title: "Select Project Root",
    });

    assert.deepEqual(result, {
      canceled: false,
      filePaths: ["/home/example/project-a"],
    });
  } finally {
    bridge.sendToRenderer = previousSend;
    window.destroy();
  }
});

test("closing a window cancels its folder dialog", async () => {
  const window = new BrowserWindow();
  const bridge = globalThis.__codexElectronIpcBridge;
  const previousSend = bridge.sendToRenderer;

  try {
    bridge.sendToRenderer = () => queueMicrotask(() => window.destroy());
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory"],
    });
    assert.deepEqual(result, { canceled: true, filePaths: [] });
  } finally {
    bridge.sendToRenderer = previousSend;
    window.destroy();
  }
});
