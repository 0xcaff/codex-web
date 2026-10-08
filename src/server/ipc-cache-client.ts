import {
  IPC_CACHE_PROTOCOL,
  IPC_CACHE_MAX_ENTRIES,
  CacheSlot,
  JsonRecord,
  isRecord,
  validDigest,
  splitCacheableMessage,
  restoreCachedMessage,
  splitBody,
} from "./ipc-cache-schema";

export interface IpcBodyCache {
  hashes(): Promise<string[]>;
  get(hash: string): Promise<string | null>;
  put(hash: string, body: string): Promise<boolean>;
  delete(hash: string): Promise<void>;
}

export class CachedIpcReceiver {
  private cache: IpcBodyCache | null = null;
  private ready = false;
  private closed = false;
  private preparing = false;
  private queue = Promise.resolve();
  private fallback: ReturnType<typeof setTimeout> | null = null;
  private waiting = new Map<
    string,
    {
      resolve: (value: JsonRecord) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private send: (value: unknown) => void,
    private deliver: (value: unknown) => void,
    private onReady: () => void,
    private onError: (error: Error) => void,
    private makeCache: (namespace: string) => Promise<IpcBodyCache>,
    private digest: (body: string) => Promise<string>,
  ) {}

  opened(): void {
    // Compatibility with older servers, or unavailable/slow browser storage.
    this.fallback = setTimeout(() => this.markReady(), 1000);
  }

  receive(message: unknown): void {
    if (this.closed) return;
    if (isRecord(message) && message.type === "ipc-cache-ready") {
      if (
        !this.preparing &&
        message.protocol === IPC_CACHE_PROTOCOL &&
        typeof message.namespace === "string"
      ) {
        this.preparing = true;
        if (message.enabled === false) this.markReady();
        else void this.prepare(message.namespace);
      }
      return;
    }
    // Replay must bypass the ordered queue: it resolves the queued cache miss.
    if (
      isRecord(message) &&
      (message.type === "ipc-cache-replay" ||
        message.type === "ipc-cache-unavailable")
    ) {
      const pending =
        typeof message.id === "string"
          ? this.waiting.get(message.id)
          : undefined;
      if (pending) {
        clearTimeout(pending.timer);
        this.waiting.delete(message.id as string);
        if (message.type === "ipc-cache-replay" && isRecord(message.message))
          pending.resolve(message.message);
        else
          pending.reject(new Error("Cached IPC replay expired; reconnecting"));
      }
      return;
    }
    this.queue = this.queue
      .then(() => this.decode(message))
      .catch((error) => {
        if (!this.closed) {
          this.close();
          this.onError(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
  }

  private async prepare(namespace: string): Promise<void> {
    try {
      this.cache = await this.makeCache(namespace);
      const hashes = (await this.cache.hashes())
        .filter(validDigest)
        .slice(0, IPC_CACHE_MAX_ENTRIES);
      if (!this.closed)
        this.send({
          type: "ipc-cache-init",
          protocol: IPC_CACHE_PROTOCOL,
          namespace,
          hashes,
        });
    } catch {
      // Plain messages remain functional when cache initialization fails.
      this.cache = null;
    } finally {
      this.markReady();
    }
  }

  private markReady(): void {
    if (this.fallback) clearTimeout(this.fallback);
    this.fallback = null;
    if (!this.closed && !this.ready) {
      this.ready = true;
      this.onReady();
    }
  }

  private async remember(message: unknown, hash: unknown): Promise<void> {
    if (!this.cache || !validDigest(hash)) return;
    const part = splitCacheableMessage(message);
    if (!part) return;
    const body = JSON.stringify(part.body);
    try {
      if ((await this.digest(body)) === hash && !this.closed) {
        const hashes: string[] = [];
        for (const segment of splitBody(body)) {
          const digest = await this.digest(segment);
          if (await this.cache.put(digest, segment)) hashes.push(digest);
        }
        if (!this.closed) this.send({ type: "ipc-cache-have", hashes });
      }
    } catch {
      /* Cache failures never discard application messages. */
    }
  }

  private async replay(id: string): Promise<JsonRecord> {
    const pending = new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("Cached IPC replay timed out"));
      }, 90000);
      this.waiting.set(id, { resolve, reject, timer });
    });
    this.send({ type: "ipc-cache-miss", id });
    return pending;
  }

  private async decode(message: unknown): Promise<void> {
    if (this.closed) return;
    if (
      isRecord(message) &&
      message.type === "ipc-cache-patch" &&
      validDigest(message.hash) &&
      isRecord(message.skeleton) &&
      Array.isArray(message.parts)
    ) {
      let original: unknown;
      try {
        const segments: string[] = [],
          hashes: string[] = [];
        for (const segment of message.parts) {
          if (!isRecord(segment) || !validDigest(segment.hash))
            throw new Error("Invalid cached IPC segment");
          const body =
            typeof segment.body === "string"
              ? segment.body
              : await this.cache?.get(segment.hash);
          if (!body || (await this.digest(body)) !== segment.hash) {
            await this.cache?.delete(segment.hash).catch(() => {});
            throw new Error("IPC segment cache miss");
          }
          segments.push(body);
          if (
            typeof segment.body === "string" &&
            (await this.cache?.put(segment.hash, body).catch(() => false))
          )
            hashes.push(segment.hash);
        }
        const body = segments.join("");
        if ((await this.digest(body)) !== message.hash)
          throw new Error("IPC body digest mismatch");
        original = restoreCachedMessage(
          message.slot as CacheSlot,
          message.skeleton,
          JSON.parse(body),
        );
        if (hashes.length && !this.closed)
          this.send({ type: "ipc-cache-have", hashes });
      } catch (error) {
        if (typeof message.id !== "string") throw error;
        original = await this.replay(message.id);
        await this.remember(original, message.hash);
      }
      if (!this.closed) {
        this.deliver(original);
        if (typeof message.id === "string")
          this.send({ type: "ipc-cache-received", id: message.id });
      }
      return;
    }
    if (isRecord(message) && message.type === "ipc-cache-data") {
      // Delivery is ordered with following references, including duplicate
      // bodies offered before a browser acknowledgement reaches the server.
      await this.remember(message.message, message.hash);
      if (!this.closed) this.deliver(message.message);
      return;
    }
    if (
      isRecord(message) &&
      message.type === "ipc-cache-ref" &&
      typeof message.id === "string" &&
      validDigest(message.hash) &&
      isRecord(message.skeleton)
    ) {
      let original: unknown;
      try {
        const body = await this.cache?.get(message.hash);
        if (!body || (await this.digest(body)) !== message.hash)
          throw new Error("IPC cache miss");
        original = restoreCachedMessage(
          message.slot as CacheSlot,
          message.skeleton,
          JSON.parse(body),
        );
      } catch {
        await this.cache?.delete(message.hash).catch(() => {});
        original = await this.replay(message.id);
        await this.remember(original, message.hash);
      }
      if (!this.closed) {
        this.deliver(original);
        this.send({ type: "ipc-cache-received", id: message.id });
      }
      return;
    }
    if (
      isRecord(message) &&
      typeof message.type === "string" &&
      message.type.startsWith("ipc-cache-")
    )
      return;
    this.deliver(message);
  }

  close(): void {
    this.closed = true;
    if (this.fallback) clearTimeout(this.fallback);
    for (const pending of this.waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("IPC connection closed"));
    }
    this.waiting.clear();
  }
}
