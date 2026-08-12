import os from "node:os";
import { parseArgs as parseCliArgs } from "node:util";
import {
  DEFAULT_UPLOAD_LIMITS,
  parseUploadLimits,
  type UploadLimits,
} from "./uploads";

export type ServerOptions = {
  host: string;
  port: number;
  allowedOrigins: string[];
  uploadLimits?: UploadLimits;
};

type NetworkInterfaceAddress = {
  address: string;
  family: string;
  internal: boolean;
};
type NetworkInterfaces = () => Record<
  string,
  NetworkInterfaceAddress[] | undefined
>;

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  server [--lan | --host <host>] [--port <port>] [--allowed-origin <origin>]",
      "",
      "Defaults:",
      "  --host 127.0.0.1",
      "  --port 8214",
      "  --lan binds 0.0.0.0 for a trusted local network (cannot be combined with --host)",
      "  --allowed-origin may be repeated to allow an exact HTTP(S) reverse-proxy origin",
      `  upload limit defaults: ${DEFAULT_UPLOAD_LIMITS.maxFileBytes} bytes per file, ${DEFAULT_UPLOAD_LIMITS.maxFiles} files, ${DEFAULT_UPLOAD_LIMITS.maxAggregateBytes} bytes total`,
      "  override with --upload-max-file-bytes, --upload-max-files, --upload-max-aggregate-bytes, or CODEX_WEB_UPLOAD_* environment variables",
      "",
      "Examples:",
      "  npm run server",
      "  npm run server -- --port 9000",
      "  npm run server -- --lan",
    ].join("\n"),
  );
}

/** Formats a browser URL, including the brackets required around IPv6 hosts. */
export function formatHttpUrl(host: string, port: number): string {
  const formattedHost = host.includes(":") ? `[${host}]` : host;
  return `http://${formattedHost}:${port}`;
}

/** Returns deterministic non-loopback addresses appropriate for operator output. */
export function getTrustedNetworkUrls(
  port: number,
  networkInterfaces: NetworkInterfaces = os.networkInterfaces,
  families: readonly string[] = ["IPv4", "IPv6"],
): string[] {
  const urls = Object.values(networkInterfaces())
    .flatMap((interfaces) => interfaces ?? [])
    .filter(
      (networkInterface) =>
        !networkInterface.internal &&
        families.includes(networkInterface.family),
    )
    .map((networkInterface) => formatHttpUrl(networkInterface.address, port));

  return [...new Set(urls)].sort((left, right) => left.localeCompare(right));
}

export function getServerStartupReport(
  options: ServerOptions,
  port: number,
  networkInterfaces: NetworkInterfaces = os.networkInterfaces,
): string[] {
  if (options.host !== "0.0.0.0") {
    return [`codex-web listening at ${formatHttpUrl(options.host, port)}`];
  }

  const candidateUrls = getTrustedNetworkUrls(port, networkInterfaces, [
    "IPv4",
  ]);
  return [
    `codex-web listening at ${formatHttpUrl(options.host, port)}`,
    "Trusted-network candidate URLs (non-loopback IPv4 interfaces):",
    ...(candidateUrls.length > 0
      ? candidateUrls.map((url) => `  ${url}`)
      : ["  (no non-loopback IPv4 interfaces found)"]),
    "",
    "TRUSTED NETWORK WARNING: anyone who can reach this service can operate Codex with the permissions and credentials of this host user. Do not expose it to an untrusted network or the public internet.",
  ];
}

export function normalizeHttpOrigin(value: string): string | null {
  if (!value || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.hostname.startsWith("*.") ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function normalizeRequestHost(value: string | undefined): string | null {
  if (!value || value !== value.trim() || /[/?#@]|:\/\//.test(value))
    return null;
  try {
    const url = new URL(`http://${value}`);
    if (url.username || url.password || url.pathname !== "/" || !url.hostname)
      return null;
    return url.host;
  } catch {
    return null;
  }
}

export function isAllowedIpcOrigin(
  originHeader: string | undefined,
  hostHeader: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (typeof originHeader !== "string") return false;
  const origin = normalizeHttpOrigin(originHeader);
  const host = normalizeRequestHost(hostHeader);
  return Boolean(
    origin &&
    host &&
    (new URL(origin).host === host || allowedOrigins.includes(origin)),
  );
}

function parsePort(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535)
    throw new Error(`Invalid port: ${raw}`);
  return parsed;
}

export function parseServerArgs(args: string[]): ServerOptions {
  const parsed = parseCliArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      help: { short: "h", type: "boolean" },
      host: { type: "string" },
      lan: { type: "boolean" },
      port: { type: "string" },
      "allowed-origin": { type: "string", multiple: true },
      "upload-max-file-bytes": { type: "string" },
      "upload-max-files": { type: "string" },
      "upload-max-aggregate-bytes": { type: "string" },
      "upload-retention-ms": { type: "string" },
    },
  });
  if (parsed.values.help) {
    printUsage();
    process.exit(0);
  }
  if (parsed.values.lan && parsed.values.host !== undefined)
    throw new Error(
      "--lan cannot be combined with --host; use one or the other",
    );
  const allowedOrigins = (parsed.values["allowed-origin"] ?? []).map(
    (origin) => {
      const normalized = normalizeHttpOrigin(origin);
      if (!normalized)
        throw new Error(
          `Invalid --allowed-origin (must be an exact HTTP(S) origin): ${origin}`,
        );
      return normalized;
    },
  );
  return {
    host: parsed.values.lan ? "0.0.0.0" : (parsed.values.host ?? "127.0.0.1"),
    port: parsed.values.port ? parsePort(parsed.values.port) : 8214,
    allowedOrigins,
    uploadLimits: parseUploadLimits({
      values: {
        maxFileBytes: parsed.values["upload-max-file-bytes"],
        maxFiles: parsed.values["upload-max-files"],
        maxAggregateBytes: parsed.values["upload-max-aggregate-bytes"],
        retentionMs: parsed.values["upload-retention-ms"],
      },
    }),
  };
}
