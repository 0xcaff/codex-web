import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { PendingChannelQueue } from "../src/server/electron/pending.js";
import {
  canonicalizeRoots,
  createBrowserRequestPolicy,
  isLoopbackHost,
  parseRendererToMainMessage,
  resolveAllowedFile,
  validateBrowserRequest,
  validateRequestHost,
} from "../src/server/security.js";

test("browser request policy accepts local and configured origins only", () => {
  const policy = createBrowserRequestPolicy({
    configuredOrigins: "https://codex.antoniobeslic.com",
    port: 8214,
  });

  assert.equal(
    validateBrowserRequest(
      {
        host: "codex.antoniobeslic.com",
        origin: "https://codex.antoniobeslic.com",
      },
      policy,
    ).ok,
    true,
  );
  assert.equal(
    validateBrowserRequest(
      { host: "127.0.0.1:8214", origin: "http://127.0.0.1:8214" },
      policy,
    ).ok,
    true,
  );
  assert.equal(
    validateBrowserRequest(
      { host: "127.0.0.1:8214", origin: "https://evil.example" },
      policy,
    ).ok,
    false,
  );
  assert.equal(
    validateBrowserRequest(
      {
        host: "evil.example",
        origin: "https://codex.antoniobeslic.com",
      },
      policy,
    ).ok,
    false,
  );
  assert.equal(validateRequestHost("codex.antoniobeslic.com", policy), true);
  assert.equal(validateRequestHost("attacker.example", policy), false);
});

test("only loopback listeners are safe by default", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("192.168.1.10"), false);
});

test("renderer messages require a known, bounded runtime shape", () => {
  const validMessages = [
    { type: "ipc-renderer-invoke", requestId: "1", channel: "a", args: [] },
    { type: "ipc-renderer-send", channel: "a", args: [1] },
    {
      type: "ipc-renderer-post-message",
      channel: "a",
      message: {},
      portIds: ["p1"],
    },
    { type: "message-port-message", portId: "p1", data: "hello" },
    { type: "message-port-close", portId: "p1" },
    {
      type: "workspace-directory-entries-request",
      requestId: "1",
      directoryPath: null,
      directoriesOnly: true,
    },
  ];

  for (const message of validMessages) {
    assert.equal(parseRendererToMainMessage(JSON.stringify(message)).ok, true);
  }

  for (const message of [
    "null",
    "[]",
    JSON.stringify({ type: "unknown" }),
    JSON.stringify({ type: "ipc-renderer-send", channel: "a", args: null }),
    JSON.stringify({
      type: "ipc-renderer-post-message",
      channel: "a",
      message: null,
      portIds: ["same", "same"],
    }),
  ]) {
    assert.equal(parseRendererToMainMessage(message).ok, false);
  }
});

test("file resolver allows regular files only inside canonical roots", async (t) => {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-web-test-"),
  );
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const allowedRoot = path.join(temporaryRoot, "allowed");
  const outsideRoot = path.join(temporaryRoot, "outside");
  await fs.mkdir(allowedRoot);
  await fs.mkdir(outsideRoot);
  const allowedFile = path.join(allowedRoot, "image.png");
  const outsideFile = path.join(outsideRoot, "secret.txt");
  await fs.writeFile(allowedFile, "image");
  await fs.writeFile(outsideFile, "secret");
  await fs.symlink(outsideFile, path.join(allowedRoot, "escape.txt"));
  const roots = await canonicalizeRoots([allowedRoot]);

  assert.ok(await resolveAllowedFile(allowedFile, roots));
  assert.equal(await resolveAllowedFile(outsideFile, roots), null);
  assert.equal(
    await resolveAllowedFile(path.join(allowedRoot, "escape.txt"), roots),
    null,
  );
});

test("pending IPC queue is bounded and releases disconnected clients", () => {
  const discarded = [];
  const queue = new PendingChannelQueue({
    channels: 2,
    entries: 3,
    entriesPerChannel: 2,
  });
  const entry = (connectionId, id) => ({
    connectionId,
    discard: () => discarded.push(id),
    id,
  });

  assert.equal(queue.enqueue("one", entry("a", "a1")), true);
  assert.equal(queue.enqueue("one", entry("a", "a2")), true);
  assert.equal(queue.enqueue("one", entry("a", "a3")), false);
  assert.equal(queue.enqueue("two", entry("b", "b1")), true);
  assert.equal(queue.enqueue("three", entry("c", "c1")), false);
  assert.equal(queue.size, 3);

  queue.removeConnection("a");
  assert.equal(queue.size, 1);
  assert.deepEqual(discarded.sort(), ["a1", "a2", "a3", "c1"]);
  assert.equal(queue.drain("two")[0].id, "b1");
  assert.equal(queue.size, 0);
});

test("SHA-256 verifier fails closed on substituted archives", async (t) => {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-hash-test-"),
  );
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const archive = path.join(temporaryRoot, "runtime.zip");
  const contents = Buffer.from("verified runtime");
  await fs.writeFile(archive, contents);
  const digest = createHash("sha256").update(contents).digest("hex");
  const verifier = path.resolve("scripts/verify_sha256");

  assert.equal(spawnSync(verifier, [archive, digest]).status, 0);
  assert.notEqual(spawnSync(verifier, [archive, "0".repeat(64)]).status, 0);
});
