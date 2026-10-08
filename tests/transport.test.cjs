const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { once } = require("node:events");
const Fastify = require("fastify");
const staticFiles = require("@fastify/static");
const WS = require("ws");
const { compressAssets } = require("../scripts/compress-assets.cjs");
const {
  WEBVIEW_STATIC_OPTIONS,
  BROWSER_SOCKET_OPTIONS,
} = require("../src/server/transport.js");

test("compressed web assets negotiate formats and retain their exact content and MIME type", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-web-assets-"));
  const app = Fastify();
  const original = Buffer.from(
    'export const example = "' + "mobile startup ".repeat(10000) + '";',
  );
  try {
    await fs.writeFile(path.join(root, "app.js"), original);
    await fs.writeFile(
      path.join(root, "small.js"),
      "export const small = true;",
    );
    await fs.writeFile(
      path.join(root, "small.js.gz"),
      "outdated compressed copy",
    );
    await fs.writeFile(
      path.join(root, "small.js.br"),
      "outdated compressed copy",
    );
    await fs.writeFile(path.join(root, "photo.png"), original);
    await compressAssets(root);
    await assert.rejects(fs.access(path.join(root, "small.js.gz")));
    await assert.rejects(fs.access(path.join(root, "small.js.br")));
    await assert.rejects(fs.access(path.join(root, "photo.png.gz")));
    await app.register(staticFiles, { root, ...WEBVIEW_STATIC_OPTIONS });
    for (const [encoding, decompress] of [
      ["gzip", zlib.gunzipSync],
      ["br", zlib.brotliDecompressSync],
    ]) {
      const response = await app.inject({
        url: "/app.js",
        headers: { "accept-encoding": encoding },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["content-encoding"], encoding);
      assert.match(response.headers["content-type"], /javascript/);
      assert.match(response.headers.vary, /accept-encoding/i);
      assert.deepEqual(decompress(response.rawPayload), original);
      assert.ok(response.rawPayload.length < original.length / 10);
      const cached = await app.inject({
        url: "/app.js",
        headers: {
          "accept-encoding": encoding,
          "if-none-match": response.headers.etag,
        },
      });
      assert.equal(cached.statusCode, 304);
    }
    const plain = await app.inject({
      url: "/app.js",
      headers: { "accept-encoding": "identity" },
    });
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.deepEqual(plain.rawPayload, original);
    const small = await app.inject({
      url: "/small.js",
      headers: { "accept-encoding": "gzip" },
    });
    assert.equal(small.statusCode, 200);
    assert.equal(small.headers["content-encoding"], undefined);
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("live IPC compression preserves large messages and supports clients without compression", async () => {
  const server = new WS.WebSocketServer({
    ...BROWSER_SOCKET_OPTIONS,
    noServer: false,
    port: 0,
    host: "127.0.0.1",
  });
  await once(server, "listening");
  const message = JSON.stringify({
    type: "shared-state",
    example: "live session state ".repeat(100000),
  });
  try {
    for (const compression of [true, false]) {
      const connected = once(server, "connection");
      const client = new WS(`ws://127.0.0.1:${server.address().port}`, {
        perMessageDeflate: compression,
      });
      try {
        await once(client, "open");
        const [peer] = await connected;
        const received = once(client, "message");
        const before = peer._socket.bytesWritten;
        peer.send(message);
        assert.equal((await received)[0].toString(), message);
        const transferred = peer._socket.bytesWritten - before;
        if (compression) {
          assert.match(client.extensions, /permessage-deflate/);
          assert.ok(transferred < Buffer.byteLength(message) / 10);
        } else {
          assert.equal(client.extensions, "");
          assert.ok(transferred >= Buffer.byteLength(message));
        }
        const reply = once(peer, "message");
        client.send('{"type":"continue"}');
        assert.equal((await reply)[0].toString(), '{"type":"continue"}');
      } finally {
        const closed = once(client, "close");
        client.close();
        await closed;
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
