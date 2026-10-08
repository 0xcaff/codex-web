import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  CachedIpcReceiver,
  type IpcBodyCache,
} from "../server/ipc-cache-client";
import {
  IPC_CACHE_MAX_BYTES,
  IPC_CACHE_MAX_ENTRIES,
  IPC_CACHE_TTL_MS,
  IPC_CACHE_MAX_ENTRY_BYTES,
  validDigest,
} from "../server/ipc-cache-schema";

type EntryMetadata = {
  id: string;
  scope: string;
  hash: string;
  bytes: number;
  touched: number;
};
const encoder = new TextEncoder();
const databaseName = "codex-web-ipc-cache-v1";

async function digest(body: string): Promise<string> {
  const bytes = encoder.encode(body);
  if (globalThis.crypto?.subtle) {
    const result = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(result), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  // LAN HTTP keeps the same hash validation as HTTPS.
  return bytesToHex(sha256(bytes));
}

function tabScope(namespace: string): { scope: string; persistent: boolean } {
  try {
    let token = sessionStorage.getItem("codex-web-ipc-tab-v1");
    if (!token || !/^[a-f0-9]{32}$/.test(token)) {
      token = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
      sessionStorage.setItem("codex-web-ipc-tab-v1", token);
    }
    return { scope: namespace + ":" + token, persistent: true };
  } catch {
    return { scope: namespace, persistent: false };
  }
}

function openDatabase(allowed: boolean): Promise<IDBDatabase | null> {
  if (!allowed || typeof indexedDB === "undefined")
    return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: IDBDatabase | null) => {
      if (settled) {
        value?.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 1200);
    try {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("bodies");
        const metadata = db.createObjectStore("metadata", { keyPath: "id" });
        metadata.createIndex("scope", "scope");
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        finish(request.result);
      };
      request.onerror = request.onblocked = () => finish(null);
    } catch {
      finish(null);
    }
  });
}

function readRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("IPC cache read timed out")),
      1500,
    );
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve(request.result);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        transaction.abort();
      } catch {}
      reject(new Error("IPC cache write timed out"));
    }, 3000);
    transaction.oncomplete = () => {
      clearTimeout(timer);
      resolve();
    };
    transaction.onerror = transaction.onabort = () => {
      clearTimeout(timer);
      reject(transaction.error || new Error("IPC cache transaction aborted"));
    };
  });
}

class BrowserBodyCache implements IpcBodyCache {
  private memory = new Map<
    string,
    { body: string; bytes: number; touched: number }
  >();
  private memoryBytes = 0;
  private database: Promise<IDBDatabase | null>;
  private pending = new Map<
    string,
    { hash: string; body: string; bytes: number }
  >();
  private writing = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private queuedBytes = 0;
  private scope: string;

  constructor(namespace: string) {
    const tab = tabScope(namespace);
    this.scope = tab.scope;
    this.database = openDatabase(tab.persistent);
  }

  async hashes(): Promise<string[]> {
    try {
      const db = await this.database;
      if (!db) return [];
      const transaction = db.transaction("metadata", "readonly");
      const rows = await readRequest<EntryMetadata[]>(
        transaction.objectStore("metadata").index("scope").getAll(this.scope),
      );
      return rows
        .filter(
          (row) =>
            row.touched > Date.now() - IPC_CACHE_TTL_MS &&
            validDigest(row.hash),
        )
        .sort((a, b) => b.touched - a.touched)
        .slice(0, IPC_CACHE_MAX_ENTRIES)
        .map((row) => row.hash);
    } catch {
      return [];
    }
  }

  async get(hash: string): Promise<string | null> {
    const memory = this.memory.get(hash);
    if (memory && memory.touched > Date.now() - IPC_CACHE_TTL_MS)
      return memory.body;
    try {
      const db = await this.database;
      if (!db) return null;
      const transaction = db.transaction(["bodies", "metadata"], "readonly");
      const id = this.scope + ":" + hash;
      const [metadata, body] = await Promise.all([
        readRequest<EntryMetadata | undefined>(
          transaction.objectStore("metadata").get(id),
        ),
        readRequest<string | undefined>(
          transaction.objectStore("bodies").get(id),
        ),
      ]);
      return metadata &&
        metadata.touched > Date.now() - IPC_CACHE_TTL_MS &&
        typeof body === "string"
        ? body
        : null;
    } catch {
      return null;
    }
  }

  async put(hash: string, body: string): Promise<boolean> {
    const bytes = encoder.encode(body).byteLength;
    if (bytes > IPC_CACHE_MAX_ENTRY_BYTES) return false;
    const previous = this.memory.get(hash);
    if (previous) this.memoryBytes -= previous.bytes;
    this.memory.delete(hash);
    this.memory.set(hash, { body, bytes, touched: Date.now() });
    this.memoryBytes += bytes;
    while (this.memoryBytes > 16 * 1024 * 1024) {
      const oldest = this.memory.entries().next().value!;
      this.memoryBytes -= oldest[1].bytes;
      this.memory.delete(oldest[0]);
    }
    // The memory copy is ready for a following reference immediately. Disk
    // writes stay bounded and never block application delivery on storage.
    if (this.queuedBytes + bytes <= IPC_CACHE_MAX_BYTES) {
      const queued = this.pending.get(hash);
      if (queued) this.queuedBytes -= queued.bytes;
      this.pending.set(hash, { hash, body, bytes });
      this.queuedBytes += bytes;
      this.scheduleFlush();
    }
    return true;
  }

  private scheduleFlush(): void {
    if (this.writing || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 50);
  }

  private async flush(): Promise<void> {
    this.writing = true;
    const batch: { hash: string; body: string; bytes: number }[] = [];
    let bytes = 0;
    for (const [hash, item] of this.pending) {
      if (
        batch.length &&
        (batch.length >= 64 || bytes + item.bytes > 4 * 1024 * 1024)
      )
        break;
      this.pending.delete(hash);
      batch.push(item);
      bytes += item.bytes;
    }
    try {
      await this.persist(batch);
    } catch {
      /* Memory and replay remain available. */
    } finally {
      this.queuedBytes -= bytes;
      this.writing = false;
      if (this.pending.size) this.scheduleFlush();
    }
  }

  private async persist(
    batch: { hash: string; body: string; bytes: number }[],
  ): Promise<void> {
    const db = await this.database;
    if (!db) return;
    const transaction = db.transaction(["bodies", "metadata"], "readwrite");
    const done = completed(transaction);
    // Budget and eviction share the write transaction, including across tabs.
    const request = transaction.objectStore("metadata").getAll();
    request.onsuccess = () => {
      const all = request.result as EntryMetadata[];
      const ids = new Set(batch.map((item) => this.scope + ":" + item.hash));
      const cutoff = Date.now() - IPC_CACHE_TTL_MS;
      const retained = all
        .filter((row) => !ids.has(row.id) && row.touched > cutoff)
        .sort((a, b) => b.touched - a.touched);
      let total = batch.reduce((sum, item) => sum + item.bytes, 0);
      const keep = new Set<string>();
      for (const row of retained) {
        if (
          keep.size >= IPC_CACHE_MAX_ENTRIES - batch.length ||
          total + row.bytes > IPC_CACHE_MAX_BYTES
        )
          continue;
        keep.add(row.id);
        total += row.bytes;
      }
      for (const row of all)
        if (!ids.has(row.id) && !keep.has(row.id)) {
          transaction.objectStore("bodies").delete(row.id);
          transaction.objectStore("metadata").delete(row.id);
        }
      for (const { hash, body, bytes } of batch) {
        const id = this.scope + ":" + hash;
        transaction.objectStore("bodies").put(body, id);
        transaction
          .objectStore("metadata")
          .put({ id, scope: this.scope, hash, bytes, touched: Date.now() });
      }
    };
    await done;
  }

  async delete(hash: string): Promise<void> {
    const queued = this.pending.get(hash);
    if (queued) {
      this.queuedBytes -= queued.bytes;
      this.pending.delete(hash);
    }
    const memory = this.memory.get(hash);
    if (memory) {
      this.memoryBytes -= memory.bytes;
      this.memory.delete(hash);
    }
    const db = await this.database;
    if (!db) return;
    const transaction = db.transaction(["bodies", "metadata"], "readwrite");
    const done = completed(transaction),
      id = this.scope + ":" + hash;
    transaction.objectStore("bodies").delete(id);
    transaction.objectStore("metadata").delete(id);
    await done;
  }
}

export function browserIpcCache(
  socket: WebSocket,
  deliver: (message: unknown) => void,
  ready: () => void,
  failed: (error: Error) => void,
): CachedIpcReceiver {
  return new CachedIpcReceiver(
    (message) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(message));
    },
    deliver,
    ready,
    failed,
    async (namespace) => new BrowserBodyCache(namespace),
    digest,
  );
}
