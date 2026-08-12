/**
 * Browser-safe schema for the websocket IPC bridge. Keep this module free of
 * Node imports: it is bundled into the renderer as well as used by the server.
 */
export const IPC_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const IPC_MAX_CHANNEL_LENGTH = 256;
export const IPC_MAX_REQUEST_ID_LENGTH = 128;
export const IPC_MAX_PORT_ID_LENGTH = 128;
export const IPC_MAX_ARRAY_LENGTH = 128;
export const IPC_MAX_PORTS_PER_MESSAGE = 16;
export const IPC_MAX_DIRECTORY_ENTRIES = 2_048;

export type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
};

export type WorkspaceDirectoryEntries = {
  directoryPath: string;
  parentPath: string | null;
  entries: WorkspaceDirectoryEntry[];
};

export type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
      sourceUrl?: string;
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
      sourceUrl?: string;
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
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
      sourceUrl?: string;
    }
  | {
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
    };

export type MainToRendererMessage =
  | {
      type: "ipc-main-event";
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: true;
      /** Omitted on the wire when an Electron invoke handler resolves undefined. */
      result?: unknown;
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: true;
      result: WorkspaceDirectoryEntries;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    };

export class IpcProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpcProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasOwnKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isBoundedString(
  value: unknown,
  maximumLength: number,
): value is string {
  return typeof value === "string" && value.length <= maximumLength;
}

function isBoundedArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length <= IPC_MAX_ARRAY_LENGTH;
}

function isRequestId(value: unknown): value is string {
  return isBoundedString(value, IPC_MAX_REQUEST_ID_LENGTH);
}

function isChannel(value: unknown): value is string {
  return isBoundedString(value, IPC_MAX_CHANNEL_LENGTH);
}

function isPortId(value: unknown): value is string {
  return isBoundedString(value, IPC_MAX_PORT_ID_LENGTH);
}

function isOptionalSourceUrl(value: unknown): boolean {
  return value === undefined || isBoundedString(value, IPC_MAX_PAYLOAD_BYTES);
}

function isDirectoryEntries(
  value: unknown,
): value is WorkspaceDirectoryEntries {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["directoryPath", "parentPath", "entries"]) ||
    !isBoundedString(value.directoryPath, IPC_MAX_PAYLOAD_BYTES) ||
    (value.parentPath !== null &&
      !isBoundedString(value.parentPath, IPC_MAX_PAYLOAD_BYTES)) ||
    !Array.isArray(value.entries) ||
    value.entries.length > IPC_MAX_DIRECTORY_ENTRIES
  ) {
    return false;
  }

  return value.entries.every(
    (entry) =>
      isRecord(entry) &&
      hasOnlyKeys(entry, ["name", "path", "type"]) &&
      isBoundedString(entry.name, IPC_MAX_PAYLOAD_BYTES) &&
      isBoundedString(entry.path, IPC_MAX_PAYLOAD_BYTES) &&
      (entry.type === "directory" || entry.type === "file"),
  );
}

export function isRendererToMainMessage(
  value: unknown,
): value is RendererToMainMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "ipc-renderer-invoke":
      return (
        hasOnlyKeys(value, [
          "type",
          "requestId",
          "channel",
          "args",
          "sourceUrl",
        ]) &&
        isRequestId(value.requestId) &&
        isChannel(value.channel) &&
        isBoundedArray(value.args) &&
        isOptionalSourceUrl(value.sourceUrl)
      );
    case "ipc-renderer-send":
      return (
        hasOnlyKeys(value, ["type", "channel", "args", "sourceUrl"]) &&
        isChannel(value.channel) &&
        isBoundedArray(value.args) &&
        isOptionalSourceUrl(value.sourceUrl)
      );
    case "ipc-renderer-post-message":
      return (
        hasOnlyKeys(value, [
          "type",
          "channel",
          "message",
          "portIds",
          "sourceUrl",
        ]) &&
        isChannel(value.channel) &&
        hasOwnKey(value, "message") &&
        Array.isArray(value.portIds) &&
        value.portIds.length <= IPC_MAX_PORTS_PER_MESSAGE &&
        value.portIds.every(isPortId) &&
        new Set(value.portIds).size === value.portIds.length &&
        isOptionalSourceUrl(value.sourceUrl)
      );
    case "message-port-message":
      return (
        hasOnlyKeys(value, ["type", "portId", "data"]) &&
        hasOwnKey(value, "data") &&
        isPortId(value.portId)
      );
    case "message-port-close":
      return hasOnlyKeys(value, ["type", "portId"]) && isPortId(value.portId);
    case "workspace-directory-entries-request":
      return (
        hasOnlyKeys(value, [
          "type",
          "requestId",
          "directoryPath",
          "directoriesOnly",
        ]) &&
        isRequestId(value.requestId) &&
        (value.directoryPath === null ||
          isBoundedString(value.directoryPath, IPC_MAX_PAYLOAD_BYTES)) &&
        typeof value.directoriesOnly === "boolean"
      );
    default:
      return false;
  }
}

export function isMainToRendererMessage(
  value: unknown,
): value is MainToRendererMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "ipc-main-event":
      return (
        hasOnlyKeys(value, ["type", "channel", "args"]) &&
        isChannel(value.channel) &&
        isBoundedArray(value.args)
      );
    case "ipc-renderer-invoke-result":
      return value.ok === true
        ? hasOnlyKeys(value, ["type", "requestId", "ok", "result"]) &&
            isRequestId(value.requestId)
        : value.ok === false &&
            hasOnlyKeys(value, ["type", "requestId", "ok", "errorMessage"]) &&
            isRequestId(value.requestId) &&
            isBoundedString(value.errorMessage, IPC_MAX_PAYLOAD_BYTES);
    case "workspace-directory-entries-result":
      return value.ok === true
        ? hasOnlyKeys(value, ["type", "requestId", "ok", "result"]) &&
            isRequestId(value.requestId) &&
            hasOwnKey(value, "result") &&
            isDirectoryEntries(value.result)
        : value.ok === false &&
            hasOnlyKeys(value, ["type", "requestId", "ok", "errorMessage"]) &&
            isRequestId(value.requestId) &&
            isBoundedString(value.errorMessage, IPC_MAX_PAYLOAD_BYTES);
    case "message-port-message":
      return (
        hasOnlyKeys(value, ["type", "portId", "data"]) &&
        hasOwnKey(value, "data") &&
        isPortId(value.portId)
      );
    case "message-port-close":
      return hasOnlyKeys(value, ["type", "portId"]) && isPortId(value.portId);
    default:
      return false;
  }
}

function jsonByteLength(serialized: string): number {
  return new TextEncoder().encode(serialized).byteLength;
}

export function serializeRendererToMainMessage(
  message: RendererToMainMessage,
): string {
  if (!isRendererToMainMessage(message)) {
    throw new IpcProtocolError("Invalid renderer-to-main IPC message");
  }
  return serializeMessage(message, isRendererToMainMessage);
}

export function serializeMainToRendererMessage(
  message: MainToRendererMessage,
): string {
  if (!isMainToRendererMessage(message)) {
    throw new IpcProtocolError("Invalid main-to-renderer IPC message");
  }
  return serializeMessage(message, isMainToRendererMessage);
}

function serializeMessage(
  message: object,
  isValidSerializedMessage: (value: unknown) => boolean,
): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(message);
  } catch {
    throw new IpcProtocolError("IPC message cannot be serialized");
  }
  if (jsonByteLength(serialized) > IPC_MAX_PAYLOAD_BYTES) {
    throw new IpcProtocolError("IPC message exceeds the maximum payload size");
  }
  if (!isValidSerializedMessage(JSON.parse(serialized))) {
    throw new IpcProtocolError("IPC message changes shape when serialized");
  }
  return serialized;
}

export function parseRendererToMainMessage(
  value: unknown,
): RendererToMainMessage | null {
  return isRendererToMainMessage(value) ? value : null;
}

export function parseMainToRendererMessage(
  value: unknown,
): MainToRendererMessage | null {
  return isMainToRendererMessage(value) ? value : null;
}
