import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  browserSaveCopy,
  wrapWorkspaceFileServices,
} from "../src/browser/workspace-file-download.ts";

function browserEnvironment() {
  const state = {
    anchor: null,
    blob: null,
    clicked: false,
    notice: null,
    revoked: null,
  };
  return {
    state,
    environment: {
      atob,
      Blob,
      URL: {
        createObjectURL(blob) {
          state.blob = blob;
          return "blob:download";
        },
        revokeObjectURL(url) {
          state.revoked = url;
        },
      },
      document: {
        body: {
          append(anchor) {
            if (anchor.tagName === "A") state.anchor = anchor;
            else state.notice = anchor;
          },
        },
        createElement(tag) {
          return {
            tagName: tag.toUpperCase(),
            style: {},
            setAttribute() {},
            click() {
              state.clicked = true;
            },
            remove() {},
          };
        },
      },
      setTimeout(callback) {
        callback();
      },
    },
  };
}

test("downloads a host file through workspaceFiles.read", async () => {
  const { state, environment } = browserEnvironment();
  const calls = [];
  const service = {
    async read(request) {
      calls.push(request);
      return { blob: Buffer.from("xlsx bytes").toString("base64") };
    },
  };

  const result = await browserSaveCopy(
    service,
    { hostId: "local", path: "/private/report.xlsx" },
    environment,
  );

  assert.deepEqual(calls, [
    {
      hostId: "local",
      path: "/private/report.xlsx",
      representation: "blob",
      maxBytes: 64 * 1024 * 1024,
    },
  ]);
  assert.equal(await state.blob.text(), "xlsx bytes");
  assert.equal(state.anchor.download, "report.xlsx");
  assert.equal(state.anchor.href, "blob:download");
  assert.equal(state.clicked, true);
  assert.equal(state.revoked, "blob:download");
  assert.deepEqual(result, { path: "report.xlsx" });
});

test("downloads supplied bytes without reading a host file", async () => {
  const { state, environment } = browserEnvironment();
  const service = {
    async read() {
      assert.fail("read must not be called for supplied bytes");
    },
  };

  await browserSaveCopy(
    service,
    { bytes: Uint8Array.from([1, 2, 3]), fileName: "folder\\chart.xlsx" },
    environment,
  );

  assert.deepEqual([...new Uint8Array(await state.blob.arrayBuffer())], [1, 2, 3]);
  assert.equal(state.anchor.download, "chart.xlsx");
});

test("does not start a download if the file cannot be read", async () => {
  const { state, environment } = browserEnvironment();
  await assert.rejects(
    browserSaveCopy(
      { read: async () => ({ text: "wrong representation" }) },
      { hostId: "local", path: "/private/report.xlsx" },
      environment,
    ),
    /blob/i,
  );
  assert.equal(state.clicked, false);
});

test("reports the browser size limit before downloading", async () => {
  const { state, environment } = browserEnvironment();
  await assert.rejects(
    browserSaveCopy(
      {
        read: async () => {
          throw new Error("Workspace file exceeds the requested size limit");
        },
      },
      { hostId: "local", path: "/private/large.xlsx" },
      environment,
    ),
    /64 MiB/,
  );
  assert.equal(state.clicked, false);
});

test("wraps saveCopy while preserving other desktop services", async () => {
  const { state, environment } = browserEnvironment();
  const workspaceFiles = {
    async read() {
      return { blob: Buffer.from("file").toString("base64") };
    },
    async saveCopy() {
      assert.fail("desktop save dialog must not run in the browser");
    },
    async write() {
      return "original service";
    },
  };
  const services = { workspaceFiles, otherService: { value: 1 } };
  const wrapped = wrapWorkspaceFileServices(services, environment);

  assert.equal(wrapped.otherService, services.otherService);
  assert.equal(await wrapped.workspaceFiles.write(), "original service");
  await wrapped.workspaceFiles.saveCopy({ hostId: "local", path: "/tmp/file" });
  assert.equal(state.clicked, true);
});

test("shows a browser error for a failed Save as operation", async () => {
  const { state, environment } = browserEnvironment();
  const wrapped = wrapWorkspaceFileServices(
    {
      workspaceFiles: {
        async read() {
          throw new Error("Workspace file exceeds the requested size limit");
        },
        async saveCopy() {
          assert.fail("native save dialog must not run");
        },
      },
    },
    environment,
  );

  await assert.rejects(
    wrapped.workspaceFiles.saveCopy({ hostId: "local", path: "/tmp/large.xlsx" }),
    /64 MiB/,
  );
  assert.equal(state.notice.tagName, "DIV");
  assert.equal(state.notice.textContent, "Files larger than 64 MiB cannot be downloaded in the browser");
  assert.equal(state.clicked, false);
});

test("prepared renderer wraps services before they are used", () => {
  const renderer = readFileSync(
    new URL(
      "../scratch/asar/webview/assets/app-initial-236e1501144c.js",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    renderer,
    /iX = window\.__ELECTRON_SHIM__\?\.wrapServices\?\.\(iX\) \?\? iX/,
  );
});
