import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveDesktopMcp } from "../src/browser/desktop-mcp.ts";

function clientFor(config) {
  return {
    async sendRequest(method, params) {
      assert.equal(method, "config/read");
      assert.deepEqual(params, { cwd: "/project", includeLayers: false });
      return { config };
    },
  };
}

test("missing or disabled desktop MCP selects dynamic tools", async () => {
  for (const config of [
    {},
    { mcp_servers: {} },
    { mcp_servers: { codex_app: { enabled: false } } },
  ]) {
    assert.equal(await resolveDesktopMcp(clientFor(config), "/project"), false);
  }
});

test("configured stdio and HTTP desktop MCP remain supported", async () => {
  for (const server of [
    { command: "/Applications/Codex.app/server", args: [] },
    { url: "http://localhost:9000/mcp" },
  ]) {
    assert.equal(
      await resolveDesktopMcp(
        clientFor({ mcp_servers: { codex_app: server } }),
        "/project",
      ),
      true,
    );
  }
});

test("invalid active MCP configuration fails instead of quietly selecting dynamic tools", async () => {
  for (const server of [
    {},
    { enabled_tools: ["test"] },
    { command: "" },
    { command: "node", url: "http://localhost/mcp" },
  ]) {
    await assert.rejects(
      resolveDesktopMcp(
        clientFor({ mcp_servers: { codex_app: server } }),
        "/project",
      ),
      /codex_app/,
    );
  }
});

test("configuration request failures and malformed responses do not become capability absence", async () => {
  const failure = new Error("app-server disconnected");
  await assert.rejects(
    resolveDesktopMcp(
      {
        sendRequest: async () => {
          throw failure;
        },
      },
      "/project",
    ),
    failure,
  );
  await assert.rejects(
    resolveDesktopMcp({ sendRequest: async () => ({}) }, "/project"),
    /config/,
  );
});

test("capabilities are refreshed per client and working directory", async () => {
  let configured = true;
  const calls = [];
  const client = {
    async sendRequest(method, params) {
      calls.push(params.cwd);
      return {
        config:
          configured && params.cwd === "/mac-project"
            ? { mcp_servers: { codex_app: { command: "node" } } }
            : {},
      };
    },
  };
  assert.equal(await resolveDesktopMcp(client, "/mac-project"), true);
  assert.equal(await resolveDesktopMcp(client, "/linux-project"), false);
  configured = false;
  assert.equal(await resolveDesktopMcp(client, "/mac-project"), false);
  assert.equal(await resolveDesktopMcp(clientFor({}), "/project"), false);
  assert.deepEqual(calls, ["/mac-project", "/linux-project", "/mac-project"]);
});

// Execute the actual patched request-building block used by both start and resume.
// This catches a helper that works but is never wired into the shipped renderer.
function buildToolParams(
  client,
  previousHint = false,
  registerDynamicTools = true,
) {
  const source = readFileSync(
    new URL(
      "../scratch/asar/webview/assets/app-initial-236e1501144c.js",
      import.meta.url,
    ),
    "utf8",
  );
  const condition = source.indexOf(
    "t.readDynamicTools != null)",
    source.indexOf("async function Man("),
  );
  const start = source.indexOf("{", condition);
  assert.notEqual(start, -1);
  const end = source.indexOf(
    "  if (t.readDeveloperInstructions != null)",
    start,
  );
  assert.notEqual(end, -1);
  const run = new Function(
    "window",
    "POt",
    "LOt",
    `return async function(e,t,n,a) { if(t.readDynamicTools != null) ${source.slice(start, end)} return a; }`,
  )(
    { __ELECTRON_SHIM__: { resolveDesktopMcp } },
    (tools) => tools,
    "mcp_servers.codex_app.enabled_tools",
  );
  return run(
    { cwd: "/project", usesDesktopMcp: previousHint, registerDynamicTools },
    {
      requestClient: client,
      readDynamicTools: async () => [{ name: "sample_tool" }],
    },
    client,
    { config: { keep: true } },
  );
}

test("shipped renderer selects MCP from server config even when the old host hint is false", async () => {
  const result = await buildToolParams(
    clientFor({ mcp_servers: { codex_app: { command: "node" } } }),
  );
  assert.deepEqual(result.dynamicTools, []);
  assert.equal(result.config["mcp_servers.codex_app.required"], true);
  assert.deepEqual(result.config["mcp_servers.codex_app.enabled_tools"], [
    "sample_tool",
  ]);
  assert.equal(result.config.keep, true);
});

test("shipped renderer does not create an incomplete MCP entry when host hint is true", async () => {
  const result = await buildToolParams(clientFor({}), true);
  assert.deepEqual(result.dynamicTools, [{ name: "sample_tool" }]);
  assert.deepEqual(result.config, { keep: true });
});

test("resume keeps its instruction to omit dynamic tool registration", async () => {
  const result = await buildToolParams(clientFor({}), true, false);
  assert.equal(result.dynamicTools, undefined);
  assert.deepEqual(result.config, { keep: true });
});
