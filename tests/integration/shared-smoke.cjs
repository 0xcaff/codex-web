// Opt-in integration: creates an isolated home/socket and uses a small amount
// of model quota. It never stops an existing server or changes global config.
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  cp = require("node:child_process");
const { chromium } = require("playwright-core");
const { connect } = require("./rpc-client.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-integration-"));
const packageRoot = path.resolve(__dirname, "../..");
const home = path.join(root, "home"),
  state = path.join(root, "web");
fs.mkdirSync(home, { mode: 0o700 });
fs.mkdirSync(state, { mode: 0o700 });
const originalHome =
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const auth = path.join(originalHome, "auth.json");
if (!fs.existsSync(auth))
  throw Error(
    "Sign in to Codex first; this test copies auth into its private temporary home.",
  );
fs.copyFileSync(auth, path.join(home, "auth.json"));
fs.chmodSync(path.join(home, "auth.json"), 0o600);
const appTools =
  process.env.CODEX_TEST_APP_TOOLS ||
  path.join(
    originalHome,
    "plugins/cache/openai-bundled/codex-app-tools/0.1.5/server.mjs",
  );
const binary = process.env.CODEX_TEST_CODEX || "codex";
const port = Number(process.env.CODEX_TEST_PORT || 8220);
const base = process.env.CODEX_TEST_HOST || "127.0.0.1";
const url = `http://${base}:${port}`,
  socketPath = path.join(root, "app.sock"),
  pipe = path.join(root, "tools.sock");
const env = {
  ...process.env,
  CODEX_HOME: home,
  CODEX_SHARED_TOOLS_PIPE_PATH: pipe,
};
delete env.CODEX_UNIX_SOCKET;
delete env.CODEX_CLI_PATH;
delete env.CODEX_SHARED_TOOLS_MCP;
delete env.NODE_OPTIONS;
const children = [];
function spawn(command, args, cwd, name) {
  const log = fs.openSync(path.join(root, name + ".log"), "a", 0o600);
  const child = cp.spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", log, log],
  });
  fs.closeSync(log);
  children.push(child);
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  let timer;
  await Promise.race([
    ended,
    new Promise((resolve) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 10000);
    }),
  ]);
  clearTimeout(timer);
  await ended;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function rpc(c, method, params) {
  const r = await c.request(method, params);
  if (r.error) throw Error(method + ": " + r.error.message);
  return r.result;
}
async function readyWeb() {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(200);
  }
  throw Error("Test Web did not start");
}
async function modelTurn(c, threadId, text) {
  let completed,
    output = "",
    turnId;
  const items = [];
  const listener = (data) => {
    const m = JSON.parse(data);
    if (m.params?.threadId !== threadId) return;
    if (m.method === "item/agentMessage/delta") output += m.params.delta;
    if (m.method === "item/completed") items.push(m.params.item);
    if (m.method === "turn/completed") completed = m.params.turn;
  };
  c.socket.on("message", listener);
  try {
    turnId = (
      await rpc(c, "turn/start", {
        threadId,
        effort: "low",
        input: [{ type: "text", text }],
      })
    ).turn.id;
    for (let i = 0; i < 900 && !completed; i++) await sleep(200);
    if (completed?.status !== "completed")
      throw Error("Test model turn did not complete");
    return { output, items };
  } finally {
    c.socket.off("message", listener);
    if (turnId && !completed)
      await c.request("turn/interrupt", { threadId, turnId }).catch(() => {});
  }
}
(async () => {
  let browser, c, web;
  const result = { root, url };
  try {
    console.log("Starting isolated shared runtime");
    spawn(
      binary,
      ["app-server", "--listen", "unix://" + socketPath],
      root,
      "server",
    );
    for (let i = 0; i < 100 && !c; i++) {
      try {
        c = await connect(socketPath);
      } catch {}
      await sleep(100);
    }
    if (!c) throw Error("Test app-server did not start");
    result.serverVersion = c.init.result.userAgent;
    const startWeb = () =>
      spawn(
        process.execPath,
        [
          path.join(packageRoot, "src/server/main.js"),
          "--host",
          "0.0.0.0",
          "--port",
          String(port),
          "--shared-socket",
          socketPath,
          "--app-tools",
          appTools,
        ],
        state,
        "web",
      );
    web = startWeb();
    await readyWeb();
    browser = await chromium.launch({
      executablePath:
        process.env.CODEX_TEST_BROWSER || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    page.on("pageerror", (error) =>
      console.error("Browser error:", error.message),
    );
    await page.goto(url);
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.waitFor({ timeout: 60000 });
    console.log("Mobile HTTP page ready; creating a Web session");
    await editor.fill(
      "Reply exactly SHARED_INTEGRATION_SEED. Do not use tools.",
    );
    await editor.press("Enter");
    const pattern =
      /\/thread\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:[/?#]|$)/;
    await page.waitForURL(pattern, { timeout: 60000 });
    const threadId = (result.threadId = page.url().match(pattern)[1]);
    await rpc(c, "thread/resume", { threadId });
    await page
      .getByText("SHARED_INTEGRATION_SEED", { exact: true })
      .first()
      .waitFor({ timeout: 180000 });
    const inventory = await rpc(c, "mcpServerStatus/list", {
      threadId,
      serverName: "codex_app",
      detail: "toolsAndAuthOnly",
    });
    result.inventoryCount = Object.keys(
      inventory.data?.find((s) => s.name === "codex_app")?.tools || {},
    ).length;
    if (!result.inventoryCount) throw Error("Desktop tool catalog was empty");
    const read = () =>
      rpc(c, "mcpServer/tool/call", {
        threadId,
        server: "codex_app",
        tool: "read_thread",
        arguments: { threadId, hostId: "local" },
        _meta: { "openai/threadId": threadId, "openai/turnId": "integration" },
      });
    if ((await read()).isError) throw Error("Initial read_thread failed");
    console.log("Desktop catalog and read_thread passed; restarting only Web");
    const previousPid = web.pid;
    await stop(web);
    web = startWeb();
    await readyWeb();
    await page.goto(`${url}/thread/${threadId}`);
    await editor.waitFor({ timeout: 60000 });
    if ((await read()).isError)
      throw Error("read_thread failed after Web restart");
    result.webPidChanged = web.pid !== previousPid;
    result.sameRpcConnection = c.socket.readyState === 1;
    console.log(
      "Shared connection survived Web restart; checking model tool calls",
    );
    const turn = await modelTurn(
      c,
      threadId,
      `Use codex_app read_thread to read thread ${threadId} on host local, and list_threads on host local. Do not run commands or modify files. After both succeed reply exactly SHARED_INTEGRATION_OK.`,
    );
    result.toolCalls = turn.items
      .filter((i) => i.type === "mcpToolCall")
      .map(({ tool, status, error, result }) => ({
        tool,
        status,
        error,
        isError: result?.isError === true,
      }));
    result.output = turn.output;
    result.passed =
      ["read_thread", "list_threads"].every((tool) =>
        result.toolCalls.some(
          (i) =>
            i.tool === tool &&
            i.status === "completed" &&
            !i.error &&
            !i.isError,
        ),
      ) &&
      turn.output.includes("SHARED_INTEGRATION_OK") &&
      result.webPidChanged &&
      result.sameRpcConnection;
    if (!result.passed)
      throw Error("Model did not successfully invoke both Desktop tools");
    await page.screenshot({ path: path.join(root, "browser.png") });
    console.log("RESULT", JSON.stringify(result));
  } catch (e) {
    result.passed = false;
    result.error = e.message;
    console.error("Diagnostics:", root);
    throw e;
  } finally {
    fs.writeFileSync(
      path.join(root, "result.json"),
      JSON.stringify(result, null, 2),
      { mode: 0o600 },
    );
    if (c) c.close();
    if (browser) await browser.close();
    for (const child of children.reverse()) await stop(child);
    fs.rmSync(path.join(home, "auth.json"), { force: true });
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
