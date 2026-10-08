const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizeOutgoing,
  selectToolsWindow,
  waitForToolsView,
} = require("../src/server/shared-compat.cjs");
const key = "mcp_servers.codex_app.enabled_tools";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
test("shared Web lifecycle requests remove the orphan Desktop tool whitelist", () => {
  process.env.CODEX_UNIX_SOCKET = "/test.sock";
  for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
    const input = {
      id: 7,
      method,
      params: {
        threadId: "test",
        config: {
          [key]: ["read_thread"],
          "features.thread_tools": true,
          "mcp_servers.user": { command: "user-mcp" },
        },
        approvalPolicy: "on-request",
      },
    };
    const output = normalizeOutgoing(input, "local");
    assert.deepEqual(output.params.config, {
      "features.thread_tools": true,
      "mcp_servers.user": { command: "user-mcp" },
    });
    assert.equal(output.params.approvalPolicy, "on-request");
    assert.deepEqual(input.params.config[key], ["read_thread"]);
  }
});
test("app-tool calls wait for renderer initialization, with bounded failure and cancellation", async () => {
  let ready = false;
  const timer = setTimeout(() => {
    ready = true;
  }, 20);
  await waitForToolsView(() => ready, undefined, 300);
  clearTimeout(timer);
  await assert.rejects(
    waitForToolsView(() => false, undefined, 10),
    /initialized codex-web page/,
  );
  const controller = new AbortController();
  controller.abort(Error("cancelled"));
  await assert.rejects(
    waitForToolsView(() => false, controller.signal),
    /cancelled/,
  );
});
test("tool discovery chooses a connected renderer rather than a virtual primary window", () => {
  const saved = process.env.CODEX_UNIX_SOCKET,
    bridge = globalThis.__codexElectronIpcBridge;
  const window = (id, focused = false) => ({
    webContents: { id },
    isDestroyed: () => false,
    isFocused: () => focused,
  });
  const virtual = window(1),
    tab = window(2),
    focused = window(3, true);
  try {
    process.env.CODEX_UNIX_SOCKET = "/shared.sock";
    globalThis.__codexElectronIpcBridge = {
      isRendererConnected: (id) => id !== 1,
    };
    assert.equal(selectToolsWindow(virtual, [virtual, tab, focused]), focused);
    assert.equal(selectToolsWindow(tab, [virtual, tab, focused]), tab);
    assert.equal(selectToolsWindow(virtual, [virtual]), null);
    delete process.env.CODEX_UNIX_SOCKET;
    assert.equal(selectToolsWindow(virtual, [virtual, tab]), virtual);
  } finally {
    if (saved === undefined) delete process.env.CODEX_UNIX_SOCKET;
    else process.env.CODEX_UNIX_SOCKET = saved;
    globalThis.__codexElectronIpcBridge = bridge;
  }
});
test("explicit MCP transports and other connections retain their allowlists", () => {
  process.env.CODEX_UNIX_SOCKET = "/test.sock";
  for (const transport of [
    { "mcp_servers.codex_app": { command: "node", args: ["server.js"] } },
    { "mcp_servers.codex_app": { url: "https://example.test/mcp" } },
    { "mcp_servers.codex_app.command": "node" },
    { mcp_servers: { codex_app: { command: "node" } } },
  ]) {
    const m = {
      method: "thread/resume",
      params: { config: { [key]: ["read_thread"], ...transport } },
    };
    assert.equal(normalizeOutgoing(m, "local"), m);
  }
  const m = { method: "thread/resume", params: { config: { [key]: [] } } };
  assert.equal(normalizeOutgoing(m, "durable"), m);
  assert.equal(
    normalizeOutgoing({ ...m, method: "config/write" }, "local").method,
    "config/write",
  );
  delete process.env.CODEX_UNIX_SOCKET;
  assert.equal(normalizeOutgoing(m, "local"), m);
});
test("a live Desktop host completes the MCP config without removing the allowlist", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tools-config-"));
  const pipe = path.join(root, "host.sock"),
    script = path.join(root, "server.mjs");
  fs.writeFileSync(script, "");
  const host = net.createServer();
  await new Promise((resolve, reject) => {
    host.once("error", reject);
    host.listen(pipe, resolve);
  });
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      CODEX_UNIX_SOCKET: "/shared.sock",
      CODEX_SHARED_TOOLS_MCP: script,
      CODEX_APP_TOOLS_PIPE_PATH: pipe,
    });
    for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
      const input = {
        method,
        params: {
          config: {
            [key]: ["read_thread"],
            model_reasoning_effort: "low",
            "mcp_servers.user": { command: "user-mcp" },
          },
          approvalPolicy: "on-request",
          sandbox: "read-only",
        },
      };
      const result = normalizeOutgoing(input, "local");
      assert.deepEqual(result.params.config[key], ["read_thread"]);
      assert.equal(
        result.params.config["mcp_servers.codex_app"].command,
        process.execPath,
      );
      assert.deepEqual(result.params.config["mcp_servers.codex_app"].args, [
        script,
      ]);
      assert.equal(
        result.params.config["mcp_servers.codex_app"].env
          .CODEX_APP_TOOLS_PIPE_PATH,
        pipe,
      );
      assert.equal(
        result.params.config["mcp_servers.codex_app"].tools.create_thread
          .approval_mode,
        "prompt",
      );
      assert.equal(result.params.config.model_reasoning_effort, "low");
      assert.equal(result.params.approvalPolicy, "on-request");
      assert.equal(result.params.sandbox, "read-only");
      assert.equal(input.params.config["mcp_servers.codex_app"], undefined);
    }
    const disabled = {
      method: "thread/start",
      params: {
        config: {
          [key]: ["read_thread"],
          "mcp_servers.codex_app.enabled": false,
        },
      },
    };
    assert.equal(
      normalizeOutgoing(disabled, "local").params.config[
        "mcp_servers.codex_app"
      ],
      undefined,
    );
    const nested = {
      method: "thread/resume",
      params: {
        config: {
          [key]: ["read_thread"],
          mcp_servers: {
            codex_app: { tool_timeout_sec: 17 },
            other: { command: "other" },
          },
        },
      },
    };
    const result = normalizeOutgoing(nested, "local");
    assert.equal(
      result.params.config.mcp_servers.codex_app.tool_timeout_sec,
      17,
    );
    assert.equal(result.params.config.mcp_servers.other.command, "other");
    await new Promise((resolve) => host.close(resolve));
    assert.equal(
      normalizeOutgoing(nested, "local").params.config[key],
      undefined,
    );
  } finally {
    for (const name of [
      "CODEX_UNIX_SOCKET",
      "CODEX_SHARED_TOOLS_MCP",
      "CODEX_APP_TOOLS_PIPE_PATH",
    ]) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    if (host.listening) await new Promise((resolve) => host.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
