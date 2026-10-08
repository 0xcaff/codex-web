// Complete Desktop's MCP configuration on the shared connection. Keep the
// orphan-whitelist fallback only when the actual tool host is unavailable.
const fs = require("node:fs");
const path = require("node:path");
const lifecycle = new Set(["thread/start", "thread/resume", "thread/fork"]);
const whitelist = "mcp_servers.codex_app.enabled_tools";
const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
function hasExplicitTransport(config) {
  const entries = [
    config["mcp_servers.codex_app"],
    config.mcp_servers?.codex_app,
  ];
  return (
    entries.some(
      (v) =>
        isObject(v) &&
        (typeof v.command === "string" || typeof v.url === "string"),
    ) ||
    typeof config["mcp_servers.codex_app.command"] === "string" ||
    typeof config["mcp_servers.codex_app.url"] === "string"
  );
}
function desktopToolsConfig() {
  const server = process.env.CODEX_SHARED_TOOLS_MCP;
  const pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH;
  if (!process.env.CODEX_UNIX_SOCKET || !server || !pipe) return null;
  try {
    if (!fs.statSync(server).isFile() || !fs.statSync(pipe).isSocket())
      return null;
    // A stale socket file after a crash must not count as a working tool host.
    const target = fs.realpathSync(pipe);
    const listening = fs
      .readFileSync("/proc/net/unix", "utf8")
      .split("\n")
      .some((line) => {
        const parts = line.trim().split(/\s+/);
        return (
          parts.length === 8 &&
          parts[7] === target &&
          parseInt(parts[3], 16) & 0x10000
        );
      });
    if (!listening) return null;
  } catch {
    return null;
  }
  return {
    command: process.execPath,
    args: [server],
    cwd: path.dirname(server),
    enabled: true,
    env: { CODEX_APP_TOOLS_PIPE_PATH: pipe },
    startup_timeout_sec: 30,
    tool_timeout_sec: 3600,
    default_tools_approval_mode: "approve",
    tools: Object.fromEntries(
      [
        "automation_update",
        "create_thread",
        "send_message_to_thread",
        "fork_thread",
        "handoff_thread",
      ].map((name) => [name, { approval_mode: "prompt" }]),
    ),
  };
}
function selectToolsWindow(preferred, windows) {
  const connected = globalThis.__codexElectronIpcBridge?.isRendererConnected;
  if (!process.env.CODEX_UNIX_SOCKET || typeof connected !== "function")
    return preferred;
  const available = windows.filter(
    (w) => !w.isDestroyed() && connected(w.webContents.id),
  );
  if (available.includes(preferred)) return preferred;
  return available.find((w) => w.isFocused()) ?? available.at(-1) ?? null;
}
async function waitForToolsView(ready, signal, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline)
      throw Error(
        "Desktop tools need an initialized codex-web page. Open the page and retry.",
      );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(100, timeoutMs)),
    );
  }
  signal?.throwIfAborted();
}
function normalizeOutgoing(message, hostId) {
  if (
    !process.env.CODEX_UNIX_SOCKET ||
    hostId !== "local" ||
    !lifecycle.has(message?.method)
  )
    return message;
  const config = message.params?.config;
  if (
    !isObject(config) ||
    !Object.hasOwn(config, whitelist) ||
    hasExplicitTransport(config)
  )
    return message;
  const next = { ...config };
  const existing =
    config["mcp_servers.codex_app"] ?? config.mcp_servers?.codex_app;
  const tools = desktopToolsConfig();
  if (
    tools &&
    existing?.enabled !== false &&
    config["mcp_servers.codex_app.enabled"] !== false
  ) {
    const merged = { ...tools, ...(isObject(existing) ? existing : {}) };
    merged.env = {
      ...tools.env,
      ...(isObject(existing?.env) ? existing.env : {}),
    };
    if (isObject(config.mcp_servers?.codex_app)) {
      next.mcp_servers = { ...config.mcp_servers, codex_app: merged };
    } else next["mcp_servers.codex_app"] = merged;
    return { ...message, params: { ...message.params, config: next } };
  }
  delete next[whitelist];
  return { ...message, params: { ...message.params, config: next } };
}
module.exports = {
  normalizeOutgoing,
  desktopToolsConfig,
  selectToolsWindow,
  waitForToolsView,
};
