type SaveCopyRequest =
  | { bytes: Uint8Array; fileName?: string }
  | { hostId: string; path: string; fileName?: string };

type WorkspaceFiles = {
  read?: (request: {
    hostId: string;
    path: string;
    representation: "blob";
    maxBytes: number;
  }) => Promise<{ blob?: unknown }>;
  saveCopy?: (request: SaveCopyRequest) => Promise<{ path: string | null }>;
};

const MAX_BROWSER_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const SIZE_LIMIT_MESSAGE =
  "Files larger than 64 MiB cannot be downloaded in the browser";

type BrowserEnvironment = {
  atob: (value: string) => string;
  Blob: typeof Blob;
  URL: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  document: Pick<Document, "createElement"> & { body: Pick<HTMLElement, "append"> };
  setTimeout: (callback: () => void, delay: number) => unknown;
};

function fileNameFor(request: SaveCopyRequest): string {
  const candidate = request.fileName ?? ("path" in request ? request.path : "");
  return candidate.split(/[\\/]/).filter(Boolean).pop() || "download";
}

function decodeBase64(base64: string, environment: BrowserEnvironment): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  // Chunking avoids allocating one more full-size binary string for large files.
  for (let offset = 0; offset < base64.length; offset += 65_536) {
    const binary = environment.atob(base64.slice(offset, offset + 65_536));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    chunks.push(bytes);
  }
  return chunks;
}

function showDownloadError(error: unknown, environment: BrowserEnvironment): void {
  const detail =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : "";
  const notice = environment.document.createElement("div");
  notice.setAttribute("role", "alert");
  notice.textContent =
    detail === SIZE_LIMIT_MESSAGE ? detail : "Could not download file";
  notice.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:2147483647;" +
    "max-width:28rem;padding:12px 16px;border-radius:8px;" +
    "background:#b42318;color:white;box-shadow:0 4px 16px #0005";
  environment.document.body.append(notice);
  environment.setTimeout(() => notice.remove(), 7_000);
}

export async function browserSaveCopy(
  workspaceFiles: WorkspaceFiles,
  request: SaveCopyRequest,
  environment: BrowserEnvironment = globalThis,
): Promise<{ path: string }> {
  let parts: BlobPart[];
  if ("bytes" in request) {
    parts = [request.bytes as BlobPart];
  } else {
    if (typeof workspaceFiles.read !== "function") {
      throw new Error("Workspace file reading is unavailable");
    }
    let result: { blob?: unknown };
    try {
      result = await workspaceFiles.read({
        hostId: request.hostId,
        path: request.path,
        representation: "blob",
        maxBytes: MAX_BROWSER_DOWNLOAD_BYTES,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /exceeds (?:the )?requested size limit/.test(error.message)
      ) {
        throw new Error(SIZE_LIMIT_MESSAGE);
      }
      throw error;
    }
    if (typeof result.blob !== "string") {
      throw new Error("Workspace file read did not return a blob");
    }
    parts = decodeBase64(result.blob, environment) as BlobPart[];
  }

  const fileName = fileNameFor(request);
  const objectUrl = environment.URL.createObjectURL(
    new environment.Blob(parts, { type: "application/octet-stream" }),
  );
  try {
    const anchor = environment.document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.style.display = "none";
    environment.document.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
    }
  } finally {
    // Revoking immediately can cancel a browser download before it starts.
    environment.setTimeout(() => environment.URL.revokeObjectURL(objectUrl), 60_000);
  }
  return { path: fileName };
}

export function wrapWorkspaceFileServices<T extends { workspaceFiles?: WorkspaceFiles }>(
  services: T,
  environment: BrowserEnvironment = globalThis,
): T {
  const workspaceFiles = services.workspaceFiles;
  if (workspaceFiles?.saveCopy == null || workspaceFiles.read == null) {
    return services;
  }

  const browserWorkspaceFiles = new Proxy(workspaceFiles, {
    get(target, property, receiver) {
      if (property === "saveCopy") {
        return async (request: SaveCopyRequest) => {
          try {
            return await browserSaveCopy(target, request, environment);
          } catch (error) {
            showDownloadError(error, environment);
            throw error;
          }
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return new Proxy(services, {
    get(target, property, receiver) {
      if (property === "workspaceFiles") return browserWorkspaceFiles;
      return Reflect.get(target, property, receiver);
    },
  });
}
