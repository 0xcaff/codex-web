import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { parseServerArgs, startIpcBridgeServer } from "./main";
import { staticCacheControl } from "./static-assets";
import {
  createUploadDirectory,
  parseUploadLimits,
  receiveUploadFiles,
  scavengeExpiredUploads,
  type UploadLimits,
} from "./uploads";

const testLimits: UploadLimits = {
  maxAggregateBytes: 64,
  maxFileBytes: 32,
  maxFiles: 2,
  retentionMs: 60_000,
};

const servers: Array<{ close: () => Promise<void> }> = [];
const temporaryDirectories: string[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-web-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function multipartBody(files: Array<{ name: string; content: string }>) {
  const boundary = "codex-web-test-boundary";
  const chunks = files.flatMap(({ name, content }) => [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="files"; filename="${name}"\r\n`,
    "Content-Type: text/plain\r\n\r\n",
    content,
    "\r\n",
  ]);
  chunks.push(`--${boundary}--\r\n`);
  return {
    body: Buffer.from(chunks.join("")),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function request(
  port: number,
  requestPath: string,
  {
    body,
    headers = {},
    method = "GET",
    origin,
  }: {
    body?: Buffer;
    headers?: Record<string, string>;
    method?: string;
    origin?: string | false;
  } = {},
): Promise<{
  body: Buffer;
  headers: http.IncomingHttpHeaders;
  statusCode: number;
}> {
  return await new Promise((resolve, reject) => {
    const client = http.request(
      {
        headers: {
          ...(body ? { "content-length": String(body.length) } : {}),
          ...(origin === false
            ? {}
            : { origin: origin ?? `http://127.0.0.1:${port}` }),
          ...headers,
        },
        host: "127.0.0.1",
        method,
        path: requestPath,
        port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks),
            headers: response.headers,
            statusCode: response.statusCode ?? 0,
          }),
        );
      },
    );
    client.once("error", reject);
    client.end(body);
  });
}

async function uploadServer(
  limits = testLimits,
  webviewRoot?: string,
  allowedOrigins: string[] = [],
) {
  const server = await startIpcBridgeServer(
    {
      allowedOrigins,
      host: "127.0.0.1",
      port: 0,
      uploadLimits: limits,
    },
    { startMainApp: false, webviewRoot },
  );
  servers.push(server);
  return server;
}

describe("bounded uploads", () => {
  it("requires an exact same or configured Origin before parsing uploads", async () => {
    const payload = multipartBody([{ content: "small", name: "small.txt" }]);
    const sameOriginServer = await uploadServer();
    const sameOrigin = await request(
      sameOriginServer.port,
      "/__backend/upload",
      {
        body: payload.body,
        headers: { "content-type": payload.contentType },
        method: "POST",
      },
    );
    expect(sameOrigin.statusCode).toBe(200);

    const configuredServer = await uploadServer(testLimits, undefined, [
      "https://codex.example.test",
    ]);
    const configured = await request(
      configuredServer.port,
      "/__backend/upload",
      {
        body: payload.body,
        headers: { "content-type": payload.contentType },
        method: "POST",
        origin: "https://codex.example.test",
      },
    );
    expect(configured.statusCode).toBe(200);

    const rejectedOrigins: Array<string | false> = [
      false,
      "https://evil.example.test",
    ];
    for (const origin of rejectedOrigins) {
      const rejected = await request(
        sameOriginServer.port,
        "/__backend/upload",
        {
          body: payload.body,
          headers: { "content-type": payload.contentType },
          method: "POST",
          origin,
        },
      );
      expect(rejected.statusCode).toBe(403);
      expect(JSON.parse(rejected.body.toString("utf8"))).toEqual({
        error: "upload origin is not allowed",
      });
    }
  });

  it("uses finite defaults and validates CLI or environment overrides", () => {
    expect(
      parseServerArgs([
        "--upload-max-file-bytes",
        "17",
        "--upload-max-files",
        "3",
        "--upload-max-aggregate-bytes",
        "50",
        "--upload-retention-ms",
        "1000",
      ]).uploadLimits,
    ).toEqual({
      maxAggregateBytes: 50,
      maxFileBytes: 17,
      maxFiles: 3,
      retentionMs: 1000,
    });
    expect(
      parseUploadLimits({
        environment: { CODEX_WEB_UPLOAD_MAX_FILES: "4" },
      }).maxFiles,
    ).toBe(4);
    expect(() =>
      parseUploadLimits({
        environment: { CODEX_WEB_UPLOAD_MAX_FILE_BYTES: "infinite" },
      }),
    ).toThrow("CODEX_WEB_UPLOAD_MAX_FILE_BYTES");
  });

  it("streams a small upload to a private owned path", async () => {
    const server = await uploadServer();
    const payload = multipartBody([{ content: "small", name: "small.txt" }]);
    const response = await request(server.port, "/__backend/upload", {
      body: payload.body,
      headers: { "content-type": payload.contentType },
      method: "POST",
    });

    expect(response.statusCode).toBe(200);
    const file = (
      JSON.parse(response.body.toString("utf8")) as {
        files: Array<{ fsPath: string; label: string }>;
      }
    ).files[0]!;
    expect(file.label).toBe("small.txt");
    await expect(fs.readFile(file.fsPath, "utf8")).resolves.toBe("small");
    expect(path.basename(path.dirname(file.fsPath))).toMatch(
      /^codex-web-upload-/,
    );
  });

  it("returns 413 for per-file, file-count, and aggregate limits", async () => {
    const server = await uploadServer();
    const perFileAndCountCases = [
      multipartBody([{ content: "x".repeat(33), name: "large.txt" }]),
      multipartBody([
        { content: "one", name: "one.txt" },
        { content: "two", name: "two.txt" },
        { content: "three", name: "three.txt" },
      ]),
    ];

    for (const payload of perFileAndCountCases) {
      const response = await request(server.port, "/__backend/upload", {
        body: payload.body,
        headers: { "content-type": payload.contentType },
        method: "POST",
      });
      expect(response.statusCode).toBe(413);
      expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({
        error: expect.stringContaining("Upload rejected"),
      });
    }

    const aggregateServer = await uploadServer({ ...testLimits, maxFiles: 3 });
    const aggregate = multipartBody([
      { content: "x".repeat(32), name: "one.txt" },
      { content: "y".repeat(32), name: "two.txt" },
      { content: "z", name: "three.txt" },
    ]);
    const aggregateResponse = await request(
      aggregateServer.port,
      "/__backend/upload",
      {
        body: aggregate.body,
        headers: { "content-type": aggregate.contentType },
        method: "POST",
      },
    );
    expect(aggregateResponse.statusCode).toBe(413);
    expect(JSON.parse(aggregateResponse.body.toString("utf8"))).toMatchObject({
      error: expect.stringContaining("aggregate upload limit"),
    });
  });

  it("removes partial files when a stream is interrupted", async () => {
    const tmpDirectory = await temporaryDirectory();
    const uploadDirectory = await createUploadDirectory({ tmpDirectory });
    const interrupted = new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(new Error("Unexpected end of multipart form"));
      },
    });
    const requestLike = {
      files: async function* () {
        yield {
          file: interrupted,
          filename: "interrupted.txt",
        };
      },
    };

    await expect(
      receiveUploadFiles({
        request: requestLike as never,
        limits: testLimits,
        uploadDirectory,
      }),
    ).rejects.toMatchObject({
      message: "Upload interrupted before completion",
      statusCode: 400,
    });
    await expect(fs.readdir(uploadDirectory)).resolves.toEqual([
      ".codex-web-upload.json",
    ]);
  });

  it("scavenges expired owned directories but skips unowned and symlink entries", async () => {
    const tmpDirectory = await temporaryDirectory();
    const expired = await createUploadDirectory({ now: 0, tmpDirectory });
    await fs.writeFile(
      path.join(expired, "file-00000000-0000-0000-0000-000000000000"),
      "x",
    );
    const unowned = path.join(
      tmpDirectory,
      "codex-web-uploads",
      "codex-web-upload-11111111-1111-1111-1111-111111111111",
    );
    await fs.mkdir(unowned);
    await fs.writeFile(
      path.join(unowned, ".codex-web-upload.json"),
      "not owned",
    );
    const link = path.join(
      tmpDirectory,
      "codex-web-uploads",
      "codex-web-upload-22222222-2222-2222-2222-222222222222",
    );
    await fs.symlink(unowned, link);

    await expect(
      scavengeExpiredUploads({
        now: 61_000,
        retentionMs: 60_000,
        tmpDirectory,
      }),
    ).resolves.toBe(1);
    await expect(fs.stat(expired)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.readFile(path.join(unowned, ".codex-web-upload.json"), "utf8"),
    ).resolves.toBe("not owned");
    await expect(fs.lstat(link)).resolves.toMatchObject({
      isSymbolicLink: expect.any(Function),
    });
  });
});

describe("precompressed static webview assets", () => {
  it("builds deterministic gzip and Brotli siblings", async () => {
    const webviewRoot = await temporaryDirectory();
    const asset = path.join(webviewRoot, "assets", "chunk-12345678.js");
    await fs.mkdir(path.dirname(asset), { recursive: true });
    const source = "const payload = 'codex-web';\n".repeat(128);
    await fs.writeFile(asset, source);
    const environment = { ...process.env, CODEX_WEBVIEW_ROOT: webviewRoot };
    const script = path.resolve("scripts/compress_webview_assets.mjs");

    await execFile(process.execPath, [script], { env: environment });
    const first = await Promise.all([
      fs.readFile(`${asset}.br`),
      fs.readFile(`${asset}.gz`),
    ]);
    expect(brotliDecompressSync(first[0]).toString("utf8")).toBe(source);
    expect(gunzipSync(first[1]).toString("utf8")).toBe(source);
    await execFile(process.execPath, [script], { env: environment });
    await expect(fs.readFile(`${asset}.br`)).resolves.toEqual(first[0]);
    await expect(fs.readFile(`${asset}.gz`)).resolves.toEqual(first[1]);
  });

  it("negotiates Brotli and applies conservative cache classes", async () => {
    const webviewRoot = await temporaryDirectory();
    await fs.mkdir(path.join(webviewRoot, "assets"));
    await fs.writeFile(
      path.join(webviewRoot, "index.html"),
      "<html>index</html>",
    );
    await fs.writeFile(
      path.join(webviewRoot, "assets", "chunk-12345678.js"),
      "console.log('chunk')",
    );
    await fs.writeFile(
      path.join(webviewRoot, "assets", "chunk-12345678.js.br"),
      "brotli",
    );
    const server = await uploadServer(testLimits, webviewRoot);

    const encoded = await request(server.port, "/assets/chunk-12345678.js", {
      headers: { "accept-encoding": "br" },
    });
    expect(encoded.statusCode).toBe(200);
    expect(encoded.headers["content-encoding"]).toBe("br");
    expect(encoded.headers.vary?.toLowerCase()).toContain("accept-encoding");
    expect(encoded.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );

    const html = await request(server.port, "/index.html");
    expect(html.headers["cache-control"]).toBe("no-cache");
    expect(staticCacheControl("/assets/chunk-12345678.js.map")).toBe(
      "no-cache",
    );
    expect(staticCacheControl("/assets/preload.js")).toBe("no-cache");
    expect(staticCacheControl("/assets/runtime.js")).toBe("no-cache");
  });
});
