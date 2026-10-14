export type ConfigClient = {
  sendRequest(
    method: string,
    params: unknown,
    options?: unknown,
  ): Promise<unknown>;
};

export async function resolveDesktopMcp(
  client: ConfigClient,
  cwd: string,
): Promise<boolean> {
  // Read through the task's client, rather than inspecting the web host's files.
  // Do not cache: project config and the connected server can change independently.
  const result = await client.sendRequest(
    "config/read",
    { cwd, includeLayers: false },
    { priority: "critical" },
  );
  if (!isRecord(result) || !isRecord(result.config)) {
    throw new Error(
      "Cannot determine desktop MCP support: invalid config/read response.",
    );
  }
  const servers = result.config.mcp_servers;
  if (servers == null) return false;
  if (!isRecord(servers)) throw new Error("Invalid mcp_servers configuration.");
  const server = servers.codex_app;
  if (server == null) return false;
  if (!isRecord(server))
    throw new Error("Invalid mcp_servers.codex_app configuration.");
  if (server.enabled === false) return false;
  if (server.enabled != null && server.enabled !== true) {
    throw new Error("Invalid mcp_servers.codex_app.enabled value.");
  }
  const command =
    typeof server.command === "string" && server.command.trim() !== "";
  const url = typeof server.url === "string" && server.url.trim() !== "";
  if ((command && server.url == null) || (url && server.command == null))
    return true;
  throw new Error(
    "Invalid mcp_servers.codex_app transport: configure either command or url, or disable the server.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
