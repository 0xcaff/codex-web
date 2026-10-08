import { createHash } from "node:crypto";
import {
  IPC_CACHE_PROTOCOL,
  IPC_CACHE_MIN_BYTES,
  IPC_CACHE_MAX_ENTRY_BYTES,
  IPC_CACHE_MAX_BYTES,
  IPC_CACHE_MAX_ENTRIES,
  IPC_CACHE_MAX_PENDING,
  isRecord,
  validDigest,
  splitCacheableMessage,
  splitBody,
} from "./ipc-cache-schema";

type PendingReference = {
  message: string;
  hash: string;
  bytes: number;
  expires: number;
};

export class ServerIpcCache {
  private active = false;
  private known = new Set<string>();
  private offered = new Set<string>();
  private pending = new Map<string, PendingReference>();
  private pendingBytes = 0;
  private sequence = 0;
  private expiry: ReturnType<typeof setInterval>;

  constructor(
    private deliver: (message: unknown) => void,
    private namespace: string,
    private enabled = true,
    private now = Date.now,
  ) {
    this.expiry = setInterval(() => this.prune(), 5000);
    this.expiry.unref();
  }

  hello(): void {
    this.deliver({
      type: "ipc-cache-ready",
      protocol: IPC_CACHE_PROTOCOL,
      namespace: this.namespace,
      enabled: this.enabled,
    });
  }

  // Control messages never enter the Desktop/app-server protocol.
  handle(message: unknown): boolean {
    if (
      !isRecord(message) ||
      typeof message.type !== "string" ||
      !message.type.startsWith("ipc-cache-")
    )
      return false;
    if (message.type === "ipc-cache-init") {
      if (
        this.enabled &&
        !this.active &&
        message.protocol === IPC_CACHE_PROTOCOL &&
        message.namespace === this.namespace
      ) {
        this.active = true;
        this.known = new Set(
          Array.isArray(message.hashes)
            ? message.hashes.slice(0, IPC_CACHE_MAX_ENTRIES).filter(validDigest)
            : [],
        );
      }
    } else if (this.active && message.type === "ipc-cache-have") {
      const hashes = Array.isArray(message.hashes)
        ? message.hashes.slice(0, IPC_CACHE_MAX_ENTRIES)
        : [message.hash];
      for (const hash of hashes.filter(validDigest)) {
        this.known.delete(hash);
        this.known.add(hash);
      }
      while (this.known.size > IPC_CACHE_MAX_ENTRIES)
        this.known.delete(this.known.values().next().value!);
    } else if (this.active && typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (message.type === "ipc-cache-miss") {
        if (!pending || pending.expires <= this.now())
          this.deliver({ type: "ipc-cache-unavailable", id: message.id });
        else {
          this.known.delete(pending.hash);
          this.offered.delete(pending.hash);
          this.deliver({
            type: "ipc-cache-replay",
            id: message.id,
            hash: pending.hash,
            message: JSON.parse(pending.message),
          });
        }
        this.remove(message.id);
      } else if (message.type === "ipc-cache-received") this.remove(message.id);
    }
    return true;
  }

  send(message: unknown): void {
    if (!this.active) {
      this.deliver(message);
      return;
    }
    const part = splitCacheableMessage(message);
    if (!part) {
      this.deliver(message);
      return;
    }
    const body = JSON.stringify(part.body),
      bytes = Buffer.byteLength(body);
    if (bytes < IPC_CACHE_MIN_BYTES || bytes > IPC_CACHE_MAX_ENTRY_BYTES) {
      this.deliver(message);
      return;
    }
    const hash = createHash("sha256").update(body).digest("hex");
    const serialized = JSON.stringify(message),
      replayBytes = Buffer.byteLength(serialized);
    this.prune();
    const segments = splitBody(body);
    if (segments.length > 1) {
      const parts = segments.map((segment) => {
        const digest = createHash("sha256").update(segment).digest("hex");
        return this.known.has(digest) || this.offered.has(digest)
          ? { hash: digest }
          : { hash: digest, body: segment };
      });
      const references = parts.some((segment) => segment.body === undefined);
      if (!references || this.canRetain(replayBytes)) {
        const id = references
          ? this.retain(serialized, hash, replayBytes)
          : undefined;
        for (const segment of parts) this.offer(segment.hash);
        this.deliver({
          type: "ipc-cache-patch",
          id,
          hash,
          slot: part.slot,
          skeleton: part.skeleton,
          parts,
        });
      } else {
        for (const segment of parts) this.offer(segment.hash);
        this.deliver({ type: "ipc-cache-data", hash, message });
      }
      return;
    }
    if (
      (this.known.has(hash) || this.offered.has(hash)) &&
      this.canRetain(replayBytes)
    ) {
      const id = this.retain(serialized, hash, replayBytes);
      this.deliver({
        type: "ipc-cache-ref",
        id,
        hash,
        slot: part.slot,
        skeleton: part.skeleton,
      });
    } else {
      this.offer(hash);
      this.deliver({ type: "ipc-cache-data", hash, message });
    }
  }

  private offer(hash: string): void {
    this.offered.delete(hash);
    this.offered.add(hash);
    while (this.offered.size > IPC_CACHE_MAX_ENTRIES)
      this.offered.delete(this.offered.values().next().value!);
  }

  private canRetain(bytes: number): boolean {
    return (
      this.pending.size < IPC_CACHE_MAX_PENDING &&
      this.pendingBytes + bytes <= IPC_CACHE_MAX_BYTES
    );
  }

  private retain(message: string, hash: string, bytes: number): string {
    const id = String(++this.sequence);
    this.pending.set(id, {
      message,
      hash,
      bytes,
      expires: this.now() + 120000,
    });
    this.pendingBytes += bytes;
    return id;
  }

  private remove(id: string): void {
    const value = this.pending.get(id);
    if (value) {
      this.pendingBytes -= value.bytes;
      this.pending.delete(id);
    }
  }

  private prune(): void {
    for (const [id, value] of this.pending)
      if (value.expires <= this.now()) this.remove(id);
  }

  dispose(): void {
    clearInterval(this.expiry);
    this.pending.clear();
    this.pendingBytes = 0;
    this.known.clear();
    this.offered.clear();
  }
}
