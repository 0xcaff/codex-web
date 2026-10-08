const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash, randomBytes } = require("node:crypto");
const { ServerIpcCache } = require("../src/server/ipc-cache.js");
const { CachedIpcReceiver } = require("../src/server/ipc-cache-client.js");
const {
  splitCacheableMessage,
  restoreCachedMessage,
} = require("../src/server/ipc-cache-schema.js");
const digest = (body) => createHash("sha256").update(body).digest("hex");
const payload = "历史记录完整保留 😀 ".repeat(1200);
const event = (body) => ({
  type: "ipc-main-event",
  channel: "codex_desktop:message-for-view",
  args: [body],
});
const snapshot = (value) =>
  event({ type: "shared-object-updated", key: "test", value });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await sleep(5);
  }
  assert.fail("Timed out waiting for IPC");
}

async function harness(storage = new Map(), options = {}) {
  const delivered = [],
    wire = [],
    controls = [],
    errors = [];
  let client,
    ready = false;
  const store = {
    hashes: async () => [...storage.keys()],
    get: async (hash) => storage.get(hash) || null,
    put: async (hash, body) => {
      if (options.writeFailure) throw Error("Browser storage quota exceeded");
      storage.set(hash, body);
      return true;
    },
    delete: async (hash) => {
      storage.delete(hash);
    },
  };
  const server = new ServerIpcCache(
    (message) => {
      const encoded = JSON.stringify(message);
      wire.push(JSON.parse(encoded));
      queueMicrotask(() => client.receive(JSON.parse(encoded)));
    },
    options.namespace || "runtime-one",
    options.enabled !== false,
  );
  client = new CachedIpcReceiver(
    (message) => {
      controls.push(message);
      queueMicrotask(() => server.handle(message));
    },
    (message) => delivered.push(message),
    () => {
      ready = true;
    },
    (error) => errors.push(error),
    async () => {
      if (options.storageFailure) throw Error("Storage unavailable");
      return store;
    },
    async (body) => digest(body),
  );
  client.opened();
  server.hello();
  await until(() => ready);
  await sleep(0);
  return {
    server,
    client,
    delivered,
    wire,
    controls,
    errors,
    storage,
    close() {
      client.close();
      server.dispose();
    },
  };
}

test("cache references preserve complete bodies and fresh routing identifiers for every supported envelope", async () => {
  const h = await harness();
  try {
    const messages = [
      snapshot({ payload }),
      event({
        type: "persisted-atom-sync",
        state: { payload },
        canWritePrimaryWindowTabPersistence: false,
      }),
      event({
        kind: "chunk",
        marker: "codec",
        transferId: "fresh-a",
        sequence: 2,
        tokens: [payload],
      }),
      { type: "message-port-message", portId: "new-port-a", data: { payload } },
    ];
    for (const message of messages) {
      const part = splitCacheableMessage(message);
      assert.deepEqual(
        restoreCachedMessage(part.slot, part.skeleton, part.body),
        message,
      );
      const before = h.delivered.length;
      h.server.send(message);
      await until(() => h.delivered.length === before + 1);
      const fresh = JSON.parse(JSON.stringify(message));
      if (fresh.args?.[0].transferId) fresh.args[0].transferId = "fresh-b";
      if (fresh.portId) fresh.portId = "new-port-b";
      h.server.send(fresh);
      await until(() => h.delivered.length === before + 2);
      assert.deepEqual(h.delivered.at(-1), fresh);
      assert.equal(h.wire.at(-1).type, "ipc-cache-ref");
      assert.ok(
        Buffer.byteLength(JSON.stringify(h.wire.at(-1))) <
          Buffer.byteLength(JSON.stringify(message)) / 100,
      );
    }
    const changed = snapshot({ payload: payload + "new update" });
    h.server.send(changed);
    await until(() => h.delivered.length === 9);
    assert.equal(h.wire.at(-1).type, "ipc-cache-data");
    assert.deepEqual(h.delivered.at(-1), changed);
    assert.deepEqual(h.errors, []);
  } finally {
    h.close();
  }
});

test("reload reuses matching cached content only after the new runtime validates its live digest", async () => {
  const storage = new Map(),
    first = await harness(storage);
  const message = snapshot({ payload });
  first.server.send(message);
  await until(() => first.delivered.length === 1);
  first.close();
  const second = await harness(storage);
  try {
    second.server.send(message);
    await until(() => second.delivered.length === 1);
    assert.equal(second.wire.at(-1).type, "ipc-cache-ref");
    assert.deepEqual(second.delivered[0], message);
    const changed = snapshot({ payload: payload + "live change" });
    second.server.send(changed);
    await until(() => second.delivered.length === 2);
    assert.equal(second.wire.at(-1).type, "ipc-cache-data");
    assert.deepEqual(second.delivered[1], changed);
  } finally {
    second.close();
  }
  const sent = [],
    server = new ServerIpcCache((message) => sent.push(message), "new-runtime");
  try {
    server.handle({
      type: "ipc-cache-init",
      protocol: 1,
      namespace: "old-runtime",
      hashes: [...storage.keys()],
    });
    server.send(message);
    assert.deepEqual(sent[0], message);
  } finally {
    server.dispose();
  }
});

test("missing or corrupted advertised entries replay the exact original without deadlocking or reordering later updates", async () => {
  for (const corrupted of [false, true]) {
    const message = snapshot({ payload });
    const hash = digest(JSON.stringify(message.args[0].value));
    const storage = new Map([[hash, JSON.stringify(message.args[0].value)]]),
      h = await harness(storage);
    try {
      if (corrupted) storage.set(hash, '{"payload":"damaged"}');
      else storage.delete(hash);
      h.server.send(message);
      const expected = JSON.parse(JSON.stringify(message));
      message.args[0].value.payload = "mutated after the reference was sent";
      const later = {
        type: "ipc-main-event",
        channel: "test",
        args: [{ approval: "fresh-state" }],
      };
      h.server.send(later);
      await until(() => h.delivered.length === 2);
      assert.deepEqual(h.delivered, [expected, later]);
      assert.ok(h.controls.some((row) => row.type === "ipc-cache-miss"));
      assert.deepEqual(h.errors, []);
    } finally {
      h.close();
    }
  }
});

test("legacy clients, disabled caching, and unavailable browser storage retain the ordinary IPC path", async () => {
  const sent = [],
    message = snapshot({ payload }),
    server = new ServerIpcCache((value) => sent.push(value), "test");
  try {
    server.send(message);
    assert.deepEqual(sent, [message]);
    assert.equal(server.handle({ type: "ipc-renderer-invoke" }), false);
  } finally {
    server.dispose();
  }
  for (const options of [{ enabled: false }, { storageFailure: true }]) {
    const h = await harness(new Map(), options);
    try {
      h.server.send(message);
      await until(() => h.delivered.length === 1);
      assert.deepEqual(h.delivered[0], message);
      assert.equal(h.wire.at(-1).type, message.type);
      assert.deepEqual(h.errors, []);
    } finally {
      h.close();
    }
  }
});

test("references expire and clear on disconnect instead of retaining unbounded replay bodies", () => {
  let now = 0;
  const sent = [],
    server = new ServerIpcCache(
      (value) => sent.push(value),
      "runtime",
      true,
      () => now,
    );
  const message = snapshot({ payload }),
    hash = digest(JSON.stringify(message.args[0].value));
  try {
    server.handle({
      type: "ipc-cache-init",
      protocol: 1,
      namespace: "runtime",
      hashes: [hash],
    });
    server.send(message);
    const ref = sent.at(-1);
    now = 120001;
    server.handle({ type: "ipc-cache-miss", id: ref.id });
    assert.equal(sent.at(-1).type, "ipc-cache-unavailable");
    server.dispose();
    server.handle({ type: "ipc-cache-miss", id: ref.id });
    assert.equal(sent.at(-1).type, "ipc-cache-unavailable");
  } finally {
    server.dispose();
  }
});

test("large bodies reuse stable segments across small insertions and validate the complete changed message", async () => {
  const h = await harness();
  const text = randomBytes(768 * 1024).toString("hex") + "😀 完整历史";
  try {
    const first = snapshot({ text, timestamp: 1 });
    h.server.send(first);
    await until(() => h.delivered.length === 1);
    assert.deepEqual(h.delivered[0], first);
    assert.equal(h.wire.at(-1).type, "ipc-cache-patch");
    const changed = snapshot({
      text: text.slice(0, 100) + "new text" + text.slice(100),
      timestamp: 2,
    });
    h.server.send(changed);
    await until(() => h.delivered.length === 2);
    assert.deepEqual(h.delivered[1], changed);
    const delta = h.wire.at(-1);
    assert.equal(delta.type, "ipc-cache-patch");
    assert.ok(
      delta.parts.filter((part) => part.body === undefined).length >
        delta.parts.length / 2,
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(delta)) <
        Buffer.byteLength(JSON.stringify(changed)) / 4,
    );
    // A missing segment must replay the immutable whole message, in order.
    for (const key of h.storage.keys()) h.storage.set(key, "corrupted");
    h.server.send(changed);
    const expected = JSON.parse(JSON.stringify(changed));
    changed.args[0].value.text = "changed after send";
    const later = { type: "message-port-close", portId: "fresh-port" };
    h.server.send(later);
    await until(() => h.delivered.length === 4);
    assert.deepEqual(h.delivered.slice(2), [expected, later]);
    assert.ok(h.controls.some((row) => row.type === "ipc-cache-miss"));
    assert.deepEqual(h.errors, []);
  } finally {
    h.close();
  }
});

test("storage write failures still deliver full segmented messages and replay following references", async () => {
  const h = await harness(new Map(), { writeFailure: true });
  const message = snapshot({
    payload: randomBytes(384 * 1024).toString("hex"),
  });
  try {
    h.server.send(message);
    h.server.send(message);
    await until(() => h.delivered.length === 2);
    assert.deepEqual(h.delivered, [message, message]);
    assert.ok(h.controls.some((row) => row.type === "ipc-cache-miss"));
    assert.deepEqual(h.errors, []);
  } finally {
    h.close();
  }
});
