// The application always receives the original message. Only the immutable
// JSON body crosses the transport by content reference when it is cached.
export type CacheSlot =
  | "args-value"
  | "args-state"
  | "args-tokens"
  | "port-data";
export type JsonRecord = Record<string, unknown>;
export const IPC_CACHE_PROTOCOL = 1;
export const IPC_CACHE_MIN_BYTES = 32 * 1024;
export const IPC_CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
export const IPC_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const IPC_CACHE_MAX_ENTRIES = 4096;
export const IPC_CACHE_MAX_PENDING = 256;
export const IPC_CACHE_TTL_MS = 60 * 60 * 1000;
export const validDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Content-defined boundaries recover after an insertion, unlike fixed offsets.
// This rolling hash chooses boundaries only; SHA-256 validates every segment.
const gear = new Uint32Array(256);
let seed = 0x9e3779b9;
for (let i = 0; i < gear.length; i++) {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  gear[i] = seed >>> 0;
}
export function splitBody(body: string): string[] {
  if (body.length < 32 * 1024) return [body];
  const parts: string[] = [];
  let start = 0,
    rolling = 0;
  for (let i = 0; i < body.length; i++) {
    const character = body.charCodeAt(i);
    rolling = ((rolling << 1) + gear[character & 255]!) >>> 0;
    const length = i + 1 - start;
    if (
      length >= 8 * 1024 &&
      ((rolling & 0x1fff) === 0 || length >= 32 * 1024) &&
      !(character >= 0xd800 && character <= 0xdbff)
    ) {
      parts.push(body.slice(start, i + 1));
      start = i + 1;
      rolling = 0;
    }
  }
  if (start < body.length) parts.push(body.slice(start));
  return parts;
}

export function splitCacheableMessage(
  message: unknown,
): { slot: CacheSlot; skeleton: JsonRecord; body: unknown } | null {
  if (!isRecord(message)) return null;
  if (message.type === "message-port-message" && message.data !== undefined) {
    const { data, ...skeleton } = message;
    return { slot: "port-data", skeleton, body: data };
  }
  if (
    message.type !== "ipc-main-event" ||
    message.channel !== "codex_desktop:message-for-view" ||
    !Array.isArray(message.args) ||
    message.args.length !== 1 ||
    !isRecord(message.args[0])
  )
    return null;
  const arg = message.args[0];
  let slot: CacheSlot, property: string;
  if (arg.type === "shared-object-updated") {
    slot = "args-value";
    property = "value";
  } else if (arg.type === "persisted-atom-sync") {
    slot = "args-state";
    property = "state";
  } else if (arg.kind === "chunk" && Array.isArray(arg.tokens)) {
    slot = "args-tokens";
    property = "tokens";
  } else return null;
  if (arg[property] === undefined) return null;
  const envelope = { ...arg };
  delete envelope[property];
  return {
    slot,
    skeleton: { ...message, args: [envelope] },
    body: arg[property],
  };
}

export function restoreCachedMessage(
  slot: CacheSlot,
  skeleton: JsonRecord,
  body: unknown,
): JsonRecord {
  if (slot === "port-data") return { ...skeleton, data: body };
  if (!Array.isArray(skeleton.args) || !isRecord(skeleton.args[0]))
    throw new Error("Invalid cached IPC envelope");
  const property = {
    "args-value": "value",
    "args-state": "state",
    "args-tokens": "tokens",
  }[slot];
  if (!property) throw new Error("Invalid cached IPC slot");
  return { ...skeleton, args: [{ ...skeleton.args[0], [property]: body }] };
}
