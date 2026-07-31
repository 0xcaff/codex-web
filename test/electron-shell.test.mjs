import assert from "node:assert/strict";
import test from "node:test";

import electron from "../src/server/electron/index.js";

test("forwards safe external URLs to the browser renderer", async () => {
  let received;
  globalThis.__codexElectronIpcBridge = {
    broadcastToRenderer(message) {
      received = message;
    },
  };

  await electron.shell.openExternal(
    "https://auth.openai.com/oauth/authorize?client_id=test-client",
  );

  assert.deepEqual(received, {
    type: "open-external",
    url: "https://auth.openai.com/oauth/authorize?client_id=test-client",
  });
});

test("rejects unsafe external URL protocols", async () => {
  await assert.rejects(
    electron.shell.openExternal("javascript:alert(1)"),
    /Unsupported external URL protocol/u,
  );
});
