import fs from "node:fs/promises";
import path from "node:path";

export const MAX_WEBSOCKET_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_MESSAGE_PORTS_PER_SOCKET = 128;

const MAX_CHANNEL_LENGTH = 256;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_IPC_ARGUMENTS = 128;
const MAX_PORT_IDS_PER_MESSAGE = 32;
const MAX_DIRECTORY_PATH_LENGTH = 16 * 1024;

export type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    }
  | {
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
    };

export type BrowserRequestPolicy = {
  allowedHosts: ReadonlySet<string>;
  allowedOrigins: ReadonlySet<string>;
};

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength
  );
}

function isBoundedArray(
  value: unknown,
  maximumLength: number,
): value is unknown[] {
  return Array.isArray(value) && value.length <= maximumLength;
}

function parseOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function createBrowserRequestPolicy({
  configuredOrigins,
  port,
}: {
  configuredOrigins?: string;
  port: number;
}): BrowserRequestPolicy {
  const originValues = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
    "http://127.0.0.1:4173",
    "http://localhost:4173",
    ...(configuredOrigins?.split(",") ?? []),
  ];
  const origins = new Set<string>();
  const hosts = new Set<string>([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);

  for (const rawValue of originValues) {
    const value = rawValue.trim();
    if (!value) {
      continue;
    }
    const url = parseOrigin(value);
    if (!url) {
      throw new Error(`Invalid CODEX_WEB_ALLOWED_ORIGINS entry: ${value}`);
    }
    origins.add(url.origin);
    hosts.add(url.host.toLowerCase());
  }

  return {
    allowedHosts: hosts,
    allowedOrigins: origins,
  };
}

export function validateBrowserRequest(
  headers: { host?: string; origin?: string },
  policy: BrowserRequestPolicy,
): ValidationResult<{ origin: string }> {
  if (typeof headers.origin !== "string") {
    return { ok: false, error: "Missing Origin header" };
  }
  const originUrl = parseOrigin(headers.origin);
  if (!originUrl || !policy.allowedOrigins.has(originUrl.origin)) {
    return { ok: false, error: "Origin is not allowed" };
  }
  if (!validateRequestHost(headers.host, policy)) {
    return { ok: false, error: "Host is not allowed" };
  }
  return { ok: true, value: { origin: originUrl.origin } };
}

export function validateRequestHost(
  host: string | undefined,
  policy: BrowserRequestPolicy,
): boolean {
  return (
    typeof host === "string" && policy.allowedHosts.has(host.toLowerCase())
  );
}

export function parseRendererToMainMessage(
  rawMessage: string,
): ValidationResult<RendererToMainMessage> {
  let value: unknown;
  try {
    value = JSON.parse(rawMessage) as unknown;
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }

  if (!isRecord(value) || typeof value.type !== "string") {
    return { ok: false, error: "Message must be an object with a type" };
  }

  const validChannel = () => isBoundedString(value.channel, MAX_CHANNEL_LENGTH);
  const validRequestId = () =>
    isBoundedString(value.requestId, MAX_IDENTIFIER_LENGTH);
  const validPortId = () =>
    isBoundedString(value.portId, MAX_IDENTIFIER_LENGTH);

  if (value.type === "ipc-renderer-invoke") {
    if (
      !validRequestId() ||
      !validChannel() ||
      !isBoundedArray(value.args, MAX_IPC_ARGUMENTS)
    ) {
      return { ok: false, error: "Invalid ipc-renderer-invoke message" };
    }
    return {
      ok: true,
      value: {
        type: value.type,
        requestId: value.requestId as string,
        channel: value.channel as string,
        args: value.args,
      },
    };
  }

  if (value.type === "ipc-renderer-send") {
    if (!validChannel() || !isBoundedArray(value.args, MAX_IPC_ARGUMENTS)) {
      return { ok: false, error: "Invalid ipc-renderer-send message" };
    }
    return {
      ok: true,
      value: {
        type: value.type,
        channel: value.channel as string,
        args: value.args,
      },
    };
  }

  if (value.type === "ipc-renderer-post-message") {
    if (
      !validChannel() ||
      !isBoundedArray(value.portIds, MAX_PORT_IDS_PER_MESSAGE) ||
      !value.portIds.every((portId) =>
        isBoundedString(portId, MAX_IDENTIFIER_LENGTH),
      ) ||
      new Set(value.portIds).size !== value.portIds.length
    ) {
      return { ok: false, error: "Invalid ipc-renderer-post-message message" };
    }
    return {
      ok: true,
      value: {
        type: value.type,
        channel: value.channel as string,
        message: value.message,
        portIds: value.portIds as string[],
      },
    };
  }

  if (value.type === "message-port-message") {
    if (!validPortId()) {
      return { ok: false, error: "Invalid message-port-message message" };
    }
    return {
      ok: true,
      value: {
        type: value.type,
        portId: value.portId as string,
        data: value.data,
      },
    };
  }

  if (value.type === "message-port-close") {
    if (!validPortId()) {
      return { ok: false, error: "Invalid message-port-close message" };
    }
    return {
      ok: true,
      value: {
        type: value.type,
        portId: value.portId as string,
      },
    };
  }

  if (value.type === "workspace-directory-entries-request") {
    const validDirectoryPath =
      value.directoryPath === null ||
      (typeof value.directoryPath === "string" &&
        value.directoryPath.length <= MAX_DIRECTORY_PATH_LENGTH);
    if (
      !validRequestId() ||
      !validDirectoryPath ||
      typeof value.directoriesOnly !== "boolean"
    ) {
      return {
        ok: false,
        error: "Invalid workspace-directory-entries-request message",
      };
    }
    return {
      ok: true,
      value: {
        type: value.type,
        requestId: value.requestId as string,
        directoryPath: value.directoryPath as string | null,
        directoriesOnly: value.directoriesOnly,
      },
    };
  }

  return { ok: false, error: "Unknown message type" };
}

export function configuredRoots(
  configuredValue: string | undefined,
  defaultRoots: string[],
): string[] {
  const values = configuredValue
    ? configuredValue.split(path.delimiter)
    : defaultRoots;
  const roots = values
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));
  return [...new Set(roots)];
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export async function canonicalizeRoots(roots: string[]): Promise<string[]> {
  return await Promise.all(roots.map((root) => fs.realpath(root)));
}

function containsPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export async function resolveAllowedFile(
  requestedPath: string,
  canonicalRoots: readonly string[],
): Promise<{ root: string; relativePath: string } | null> {
  const absolutePath = path.resolve(
    path.parse(process.cwd()).root,
    requestedPath,
  );
  let realPath: string;
  try {
    realPath = await fs.realpath(absolutePath);
    const stat = await fs.stat(realPath);
    if (!stat.isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  const root = canonicalRoots.find((candidate) =>
    containsPath(candidate, realPath),
  );
  if (!root) {
    return null;
  }
  return {
    root,
    relativePath: path.relative(root, realPath),
  };
}

export async function resolveAllowedDirectory(
  requestedPath: string,
  canonicalRoots: readonly string[],
): Promise<string | null> {
  let realPath: string;
  try {
    realPath = await fs.realpath(path.resolve(requestedPath));
    const stat = await fs.stat(realPath);
    if (!stat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  return canonicalRoots.some((root) => containsPath(root, realPath))
    ? realPath
    : null;
}
