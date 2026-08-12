import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyRequest } from "fastify";

const UPLOAD_CONTAINER = "codex-web-uploads";
const UPLOAD_DIRECTORY_PREFIX = "codex-web-upload-";
const UPLOAD_METADATA_FILE = ".codex-web-upload.json";
const UPLOAD_FILE_PREFIX = "file-";

export const DEFAULT_UPLOAD_LIMITS = {
  maxAggregateBytes: 100 * 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
  maxFiles: 32,
  retentionMs: 24 * 60 * 60 * 1000,
} as const;

export type UploadLimits = {
  maxAggregateBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  retentionMs: number;
};

export type UploadedFile = {
  fsPath: string;
  label: string;
  path: string;
};

export class UploadError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 413 = 413,
  ) {
    super(message);
  }
}

function parseFinitePositiveInteger(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${name}: expected a finite positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: expected a finite positive integer`);
  }
  return parsed;
}

export function parseUploadLimits({
  environment = process.env,
  values = {},
}: {
  environment?: NodeJS.ProcessEnv;
  values?: Partial<Record<keyof UploadLimits, string | undefined>>;
} = {}): UploadLimits {
  const fromCliOrEnvironment = (
    key: keyof UploadLimits,
    environmentKey: string,
    cliName: string,
    fallback: number,
  ): number =>
    parseFinitePositiveInteger(
      values[key] ?? environment[environmentKey],
      values[key] === undefined ? environmentKey : cliName,
      fallback,
    );

  return {
    maxFileBytes: fromCliOrEnvironment(
      "maxFileBytes",
      "CODEX_WEB_UPLOAD_MAX_FILE_BYTES",
      "--upload-max-file-bytes",
      DEFAULT_UPLOAD_LIMITS.maxFileBytes,
    ),
    maxFiles: fromCliOrEnvironment(
      "maxFiles",
      "CODEX_WEB_UPLOAD_MAX_FILES",
      "--upload-max-files",
      DEFAULT_UPLOAD_LIMITS.maxFiles,
    ),
    maxAggregateBytes: fromCliOrEnvironment(
      "maxAggregateBytes",
      "CODEX_WEB_UPLOAD_MAX_AGGREGATE_BYTES",
      "--upload-max-aggregate-bytes",
      DEFAULT_UPLOAD_LIMITS.maxAggregateBytes,
    ),
    retentionMs: fromCliOrEnvironment(
      "retentionMs",
      "CODEX_WEB_UPLOAD_RETENTION_MS",
      "--upload-retention-ms",
      DEFAULT_UPLOAD_LIMITS.retentionMs,
    ),
  };
}

function uploadContainerPath(tmpDirectory = os.tmpdir()): string {
  return path.join(tmpDirectory, UPLOAD_CONTAINER);
}

function metadata(createdAt: number): string {
  return `${JSON.stringify({
    createdAt,
    schema: "codex-web-upload-v1",
  })}\n`;
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function isOwnedUploadFile(name: string): boolean {
  return (
    name === UPLOAD_METADATA_FILE ||
    new RegExp(`^${UPLOAD_FILE_PREFIX}[0-9a-f-]{36}$`).test(name)
  );
}

function isInterruptedUpload(error: unknown): boolean {
  const errno = error as NodeJS.ErrnoException;
  if (["ECONNABORTED", "ECONNRESET", "EPIPE"].includes(errno.code ?? "")) {
    return true;
  }
  return (
    error instanceof Error &&
    /(?:aborted|terminated early|unexpected end of (?:form|multipart))/i.test(
      error.message,
    )
  );
}

async function removeOwnedUploadDirectory(directory: string): Promise<boolean> {
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    return false;
  }

  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (
    !entries.every((entry) => entry.isFile() && isOwnedUploadFile(entry.name))
  ) {
    return false;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const entryStat = await fs.lstat(entryPath);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      return false;
    }
  }

  await Promise.all(
    entries.map((entry) => fs.unlink(path.join(directory, entry.name))),
  );
  await fs.rmdir(directory);
  return true;
}

/** Removes only expired, metadata-marked directories created by this server. */
export async function scavengeExpiredUploads({
  now = Date.now(),
  retentionMs,
  tmpDirectory = os.tmpdir(),
}: {
  now?: number;
  retentionMs: number;
  tmpDirectory?: string;
}): Promise<number> {
  const container = uploadContainerPath(tmpDirectory);
  let entries: Dirent[];
  try {
    const containerStat = await fs.lstat(container);
    if (!containerStat.isDirectory() || containerStat.isSymbolicLink()) {
      return 0;
    }
    entries = await fs.readdir(container, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !new RegExp(`^${UPLOAD_DIRECTORY_PREFIX}[0-9a-f-]{36}$`).test(entry.name)
    ) {
      continue;
    }
    const directory = path.join(container, entry.name);
    const metadataPath = path.join(directory, UPLOAD_METADATA_FILE);
    try {
      const markerStat = await fs.lstat(metadataPath);
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
        continue;
      }
      const marker: unknown = JSON.parse(
        await fs.readFile(metadataPath, "utf8"),
      );
      if (
        !marker ||
        typeof marker !== "object" ||
        (marker as { schema?: unknown }).schema !== "codex-web-upload-v1" ||
        !Number.isFinite((marker as { createdAt?: unknown }).createdAt)
      ) {
        continue;
      }
      const createdAt = (marker as { createdAt: number }).createdAt;
      if (now - createdAt < retentionMs) {
        continue;
      }
      if (await removeOwnedUploadDirectory(directory)) {
        removed += 1;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Another process or a manual edit should never make scavenging fatal.
        continue;
      }
    }
  }
  return removed;
}

export async function createUploadDirectory({
  now = Date.now(),
  tmpDirectory = os.tmpdir(),
}: {
  now?: number;
  tmpDirectory?: string;
} = {}): Promise<string> {
  const container = uploadContainerPath(tmpDirectory);
  await fs.mkdir(container, { mode: 0o700, recursive: true });
  const containerStat = await fs.lstat(container);
  if (!containerStat.isDirectory() || containerStat.isSymbolicLink()) {
    throw new Error("Upload storage container is not a safe directory");
  }
  await fs.chmod(container, 0o700);
  const directory = path.join(
    container,
    `${UPLOAD_DIRECTORY_PREFIX}${randomUUID()}`,
  );
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    await fs.writeFile(
      path.join(directory, UPLOAD_METADATA_FILE),
      metadata(now),
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
  } catch (error) {
    await fs.rmdir(directory).catch(() => undefined);
    throw error;
  }
  return directory;
}

class AggregateLimitTransform extends Transform {
  constructor(
    private readonly limits: UploadLimits,
    private readonly total: { bytes: number },
  ) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.total.bytes += chunk.length;
    if (this.total.bytes > this.limits.maxAggregateBytes) {
      callback(
        new UploadError(
          `Upload rejected: aggregate upload limit of ${this.limits.maxAggregateBytes} bytes exceeded`,
        ),
      );
      return;
    }
    callback(null, chunk);
  }
}

export async function receiveUploadFiles({
  request,
  limits,
  uploadDirectory,
}: {
  request: FastifyRequest;
  limits: UploadLimits;
  uploadDirectory: string;
}): Promise<UploadedFile[]> {
  const files: UploadedFile[] = [];
  const partials: string[] = [];
  const total = { bytes: 0 };

  try {
    let count = 0;
    for await (const part of request.files()) {
      count += 1;
      if (count > limits.maxFiles) {
        throw new UploadError(
          `Upload rejected: file count limit of ${limits.maxFiles} exceeded`,
        );
      }
      const label = part.filename?.trim() || "upload";
      const uploadedPath = path.join(
        uploadDirectory,
        `${UPLOAD_FILE_PREFIX}${randomUUID()}`,
      );
      partials.push(uploadedPath);
      const output = createWriteStream(uploadedPath, {
        flags: "wx",
        mode: 0o600,
      });
      try {
        await pipeline(
          part.file,
          new AggregateLimitTransform(limits, total),
          output,
        );
      } catch (error) {
        output.destroy();
        throw error;
      }
      if (part.file.truncated) {
        throw new UploadError(
          `Upload rejected: ${label} exceeds the per-file limit of ${limits.maxFileBytes} bytes`,
        );
      }
      partials.pop();
      files.push({ label, path: uploadedPath, fsPath: uploadedPath });
    }
    return files;
  } catch (error) {
    await Promise.all(partials.map((filePath) => removeIfPresent(filePath)));
    await Promise.all(files.map((file) => removeIfPresent(file.fsPath)));
    if (error instanceof UploadError) {
      throw error;
    }
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (statusCode === 413) {
      throw new UploadError(
        `Upload rejected: file count or per-file limit exceeded (maximum ${limits.maxFiles} files, ${limits.maxFileBytes} bytes each)`,
      );
    }
    if (isInterruptedUpload(error)) {
      throw new UploadError("Upload interrupted before completion", 400);
    }
    throw error;
  }
}
