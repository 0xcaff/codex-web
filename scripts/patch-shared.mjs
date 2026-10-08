#!/usr/bin/env node
// Fail visibly when the pinned Desktop bundle changes instead of silently
// applying a compatibility patch to an unknown serializer or tool host.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const build = path.join(root, "scratch/asar/.vite/build");
function replace(file, before, after) {
  const source = fs.readFileSync(file, "utf8");
  if (source.includes(after)) return;
  if (source.split(before).length !== 2)
    throw Error(
      `Desktop compatibility anchor changed: ${path.basename(file)}: ${before.slice(0, 70)}`,
    );
  fs.writeFileSync(file, source.replace(before, after));
}
const serializer =
  "a=this.options.transformOutgoingMessage==null?e:this.options.transformOutgoingMessage(e),o=";
const normalized =
  'a=require("./shared-compat.cjs").normalizeOutgoing(this.options.transformOutgoingMessage==null?e:this.options.transformOutgoingMessage(e),this.options.hostId),o=';
const bundles = fs
  .readdirSync(build)
  .filter((name) => /^src-.*\.js$/.test(name))
  .map((name) => path.join(build, name))
  .filter((file) => {
    const content = fs.readFileSync(file, "utf8");
    return content.includes(serializer) || content.includes(normalized);
  });
if (bundles.length !== 1)
  throw Error("Expected one Desktop AppServerConnection serializer");
replace(bundles[0], serializer, normalized);
fs.copyFileSync(
  path.join(root, "src/server/shared-compat.cjs"),
  path.join(build, "shared-compat.cjs"),
);
const mains = fs
  .readdirSync(build)
  .filter((name) => /^main-.*\.js$/.test(name));
if (mains.length !== 1) throw Error("Expected one Desktop main bundle");
const main = path.join(build, mains[0]);
replace(
  main,
  "let Ne = await mie({\n",
  "let Ne = await mie({\n    pipePath: process.env.CODEX_UNIX_SOCKET ? process.env.CODEX_SHARED_TOOLS_PIPE_PATH : undefined,\n",
);
const launch =
  "async function tk({ hostConfig: e, resourcesPath: t = process.resourcesPath }) {\n";
replace(
  main,
  launch,
  launch +
    '  if (e.kind === `local` && process.env.CODEX_UNIX_SOCKET) {\n    const config = require("./shared-compat.cjs").desktopToolsConfig();\n    if (config) return [`mcp_servers.codex_app=${rk(config)}`];\n  }\n',
);
const catalog =
  "  requestDynamicToolsForThreadStart(e, t = !1, n = `default`) {\n    let r = this.windowManager.getPrimaryWindow();";
replace(
  main,
  catalog,
  catalog.replace(
    "this.windowManager.getPrimaryWindow()",
    'require("./shared-compat.cjs").selectToolsWindow(this.windowManager.getPrimaryWindow(), l.BrowserWindow.getAllWindows())',
  ),
);
const call = "  async callDynamicAppTool(e, t) {\n    t.throwIfAborted();";
replace(
  main,
  call,
  call +
    `
    if (process.env.CODEX_UNIX_SOCKET && globalThis.__codexElectronIpcBridge?.isRendererConnected) {
      await require("./shared-compat.cjs").waitForToolsView(() =>
        Array.from(this.readyAppViewWebContentsIds).some(id =>
          this.appViewsByWebContentsId.has(id) && globalThis.__codexElectronIpcBridge.isRendererConnected(id)), t);
    }`,
);
const webview = path.join(root, "scratch/asar/webview");
fs.copyFileSync(
  path.join(root, "src/browser/browser-uuid.js"),
  path.join(webview, "assets/browser-uuid.js"),
);
const script = '    <script type="module" src="./assets/preload.js"></script>';
replace(
  path.join(webview, "index.html"),
  script,
  '    <!-- CODEX_WEB_RUNTIME -->\n    <script src="./assets/browser-uuid.js"></script>\n' +
    script,
);
const assets = path.join(webview, "assets");
const workers = fs
  .readdirSync(assets)
  .filter((name) => /^runtime\.worker-.*\.js$/.test(name));
if (workers.length !== 3) throw Error("Desktop runtime worker layout changed");
for (const name of workers) {
  const file = path.join(assets, name),
    source = fs.readFileSync(file, "utf8");
  const prefix = 'import "./browser-uuid.js";\n';
  if (!source.startsWith(prefix)) fs.writeFileSync(file, prefix + source);
}
console.log("Shared runtime and LAN browser compatibility patches applied");
