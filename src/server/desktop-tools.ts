// Load the user's existing official MCP implementation at runtime. The plugin
// and credentials are not copied into this repository or its npm package.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export function prepareDesktopTools(explicitSource?: string): string | null {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const requestedSource = explicitSource ?? process.env.CODEX_SHARED_TOOLS_MCP;
  const source =
    requestedSource ??
    path.join(
      codexHome,
      "plugins/cache/openai-bundled/codex-app-tools/0.1.5/server.mjs",
    );
  if (!fs.existsSync(source)) {
    if (requestedSource) throw Error(`Desktop MCP source not found: ${source}`);
    console.warn(
      "[shared-tools] Official codex-app-tools 0.1.5 is not installed. Session viewing still works; use --app-tools to supply server.mjs.",
    );
    return null;
  }
  let content = fs.readFileSync(source, "utf8");
  function replace(before: string, after: string): void {
    if (content.includes(after)) return;
    if (content.split(before).length !== 2)
      throw Error(
        "Unsupported codex-app-tools implementation; expected validated 0.1.5",
      );
    content = content.replace(before, after);
  }
  try {
    replace(
      "capabilities: { tools: {} },",
      'capabilities: { tools: {}, experimental: {"codex/tool-catalog-cache": {cacheable: false}} },',
    );
    replace(
      `  const { tools } = appToolsSchema.parse(
    await getHostClient().request("tools/list", {
      // Work has no per-task enabled_tools override. Keep its existing catalog.
      threadStartKind: interactionClientId == null ? "all" : "default"
    })
  );`,
      `  let tools = [];
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && tools.length === 0) {
    const catalog = await getHostClient().request("tools/list", {
      threadStartKind: interactionClientId == null ? "all" : "default"
    }, AbortSignal.timeout(8000));
    tools = appToolsSchema.parse(catalog).tools;
    if (tools.length === 0) await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (tools.length === 0) throw new McpError(ErrorCode.ConnectionClosed,
    "Desktop tools are not ready. Open codex-web and retry.");`,
    );
  } catch (error) {
    if (requestedSource) throw error;
    console.warn(
      `[shared-tools] ${String(error)}. Continuing without Desktop MCP.`,
    );
    return null;
  }
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const cache = path.join(
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
    "codex-web/desktop-tools",
    hash,
  );
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const target = path.join(cache, "server.mjs");
  if (!fs.existsSync(target)) {
    try {
      fs.writeFileSync(target, content, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return target;
}
