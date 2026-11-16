// Run with: node --test scripts/tests/*.test.cjs
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { WebSocket } = require("ws");

const root = path.resolve(__dirname, "../..");
const bash = execFileSync("bash", ["-c", 'printf "%s" "$BASH"'], {
  encoding: "utf8",
});
let build;

before(() => {
  build = fs.mkdtempSync(path.join(os.tmpdir(), "codex-preflight-build-"));
  // Compile the actual entrypoint in isolation, preserving local build outputs.
  execFileSync(
    process.execPath,
    [
      require.resolve("typescript/bin/tsc"),
      "--project",
      path.join(root, "src/server/tsconfig.json"),
      "--outDir",
      path.join(build, "src/server"),
      "--declaration",
      "false",
      "--declarationMap",
      "false",
      "--sourceMap",
      "false",
    ],
    { stdio: "pipe" },
  );
  fs.symlinkSync(
    path.join(root, "node_modules"),
    path.join(build, "node_modules"),
    "dir",
  );
  const upstream = path.join(build, "scratch/asar");
  fs.mkdirSync(path.join(upstream, "webview"), { recursive: true });
  fs.writeFileSync(
    path.join(upstream, "package.json"),
    JSON.stringify({
      version: "0.0.0-test",
      main: "main.cjs",
    }),
  );
  fs.writeFileSync(
    path.join(upstream, "main.cjs"),
    'console.log("Mock upstream loaded");\n',
  );
  fs.writeFileSync(
    path.join(upstream, "webview/index.html"),
    "<html>Test client</html>",
  );
});

after(() => {
  if (build) fs.rmSync(build, { recursive: true, force: true });
});

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-startup-"));
  const bin = path.join(directory, "bin");
  const socket = path.join(directory, "control socket.sock");
  const proxy = path.join(bin, "codex_remote_proxy");
  const invoked = path.join(directory, "invoked");
  const listenLog = path.join(directory, "listen-attempts");
  const observer = path.join(directory, "observe-listen.cjs");
  const children = [];
  const sockets = new Set();
  let connections = 0;
  const server = net.createServer((client) => {
    connections++;
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.destroy();
  });
  t.after(async () => {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await closed;
    }
    for (const client of sockets) client.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    fs.chmodSync(directory, 0o700);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.mkdirSync(bin);
  fs.symlinkSync(bash, path.join(bin, "bash"));
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.copyFileSync(path.join(root, "scripts/codex_remote_proxy"), proxy);
  fs.chmodSync(proxy, 0o755);
  const writeExecutable = (name, body) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!${bash}\n${body}\n`, { mode: 0o755 });
    return file;
  };
  writeExecutable(
    "websocat",
    'printf "websocat\\n" >> "$INVOCATION_LOG"\nexit 99',
  );
  const cli = writeExecutable(
    "codex",
    'printf "codex\\n" >> "$INVOCATION_LOG"\nexit 99',
  );
  // Record every listen attempt, including a transient bind before an error.
  fs.writeFileSync(
    observer,
    `
const fs = require("node:fs");
const net = require("node:net");
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  fs.appendFileSync(process.env.LISTEN_LOG, "listen\\n");
  return listen.apply(this, args);
};
`,
  );
  server.listen(socket);
  await once(server, "listening");
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));

  return {
    bin,
    cli,
    directory,
    invoked,
    listenLog,
    port,
    proxy,
    socket,
    writeExecutable,
    get connections() {
      return connections;
    },
    async start(
      environment = {},
      args = ["--port", String(port)],
      launcher = false,
    ) {
      const serverCommand = require(path.join(root, "package.json")).scripts
        .server;
      const child = spawn(
        launcher ? bash : process.execPath,
        launcher
          ? ["-c", `${serverCommand} "$@"`, "server", ...args]
          : [
              "--require",
              observer,
              path.join(build, "src/server/main.js"),
              ...args,
            ],
        {
          cwd: launcher ? build : directory,
          env: {
            ...process.env,
            NODE_OPTIONS: launcher ? `--require=${observer}` : undefined,
            PATH: bin,
            CODEX_CLI_PATH: proxy,
            CODEX_CLI_KIND: undefined,
            CODEX_UNIX_SOCKET: socket,
            INVOCATION_LOG: invoked,
            LISTEN_LOG: listenLog,
            ...environment,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      let ready;
      const started = new Promise((resolve) => {
        ready = resolve;
      });
      child.stdout.on("data", (data) => {
        stdout += data;
        if (stdout.includes("Mock upstream loaded")) ready({ listening: true });
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      const closed = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) =>
          resolve({ code, signal, listening: false }),
        );
      });
      children.push({ child, closed });
      let timer;
      let state;
      try {
        state = await Promise.race([
          started,
          closed,
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(`Startup did not finish:\n${stdout}\n${stderr}`),
                ),
              10000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      return { ...state, stdout, stderr, child };
    },
  };
}

async function assertFailure(fixture, result, diagnostic) {
  assert.equal(result.listening, false, result.stdout);
  assert.notEqual(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /\[codex-web\] Startup failed:/);
  assert.match(result.stderr, diagnostic);
  assert.doesNotMatch(result.stdout + result.stderr, /IPC bridge listening/);
  assert.equal(
    fs.existsSync(fixture.listenLog),
    false,
    "the bridge must never call listen",
  );
  assert.equal(
    fs.existsSync(fixture.invoked),
    false,
    "neither CLI nor websocat may launch",
  );
  assert.equal(
    fixture.connections,
    0,
    "preflight must not connect to app-server",
  );
  const client = net.connect(fixture.port, "127.0.0.1");
  try {
    const error = await new Promise((resolve, reject) => {
      client.once("error", resolve);
      client.once("connect", () =>
        reject(new Error("the IPC port accepted a connection")),
      );
      client.setTimeout(1000, () =>
        reject(new Error("the IPC port probe timed out")),
      );
    });
    assert.equal(
      error.code,
      "ECONNREFUSED",
      "the IPC port must not accept connections",
    );
  } finally {
    client.destroy();
  }
}

async function assertListening(fixture, result) {
  assert.equal(result.listening, true, result.stderr);
  assert.match(
    result.stdout,
    new RegExp(`IPC bridge listening at ws://127\\.0\\.0\\.1:${fixture.port}`),
  );
  assert.equal(fs.readFileSync(fixture.listenLog, "utf8"), "listen\n");
  assert.equal(
    fs.existsSync(fixture.invoked),
    false,
    "preflight must not launch a CLI session",
  );
  assert.equal(fixture.connections, 0);
  const response = await new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${fixture.port}/`, (response) => {
        response.resume();
        resolve(response);
      })
      .on("error", reject);
  });
  assert.equal(response.statusCode, 200);
  const websocket = new WebSocket(
    `ws://127.0.0.1:${fixture.port}/__backend/ipc`,
    { handshakeTimeout: 1000 },
  );
  try {
    await once(websocket, "open");
  } finally {
    websocket.terminate();
  }
}

test("startup rejects a remote proxy without websocat before listening", async (t) => {
  const fixture = await setup(t);
  fs.unlinkSync(path.join(fixture.bin, "websocat"));
  // Exercise the default port (8214); the observer proves no bind was attempted.
  await assertFailure(
    fixture,
    await fixture.start({}, []),
    /websocat.*not found in PATH.*Install websocat/,
  );
});

test("the server npm script preserves a configured proxy path containing spaces", async (t) => {
  const fixture = await setup(t);
  const alias = path.join(fixture.directory, "configured proxy");
  fs.symlinkSync(fixture.proxy, alias);
  fs.unlinkSync(path.join(fixture.bin, "websocat"));
  await assertFailure(
    fixture,
    await fixture.start({ CODEX_CLI_PATH: alias }, undefined, true),
    /websocat.*not found in PATH/,
  );
});

test("the server npm script defaults to the regular CLI in PATH", async (t) => {
  const fixture = await setup(t);
  fs.unlinkSync(path.join(fixture.bin, "websocat"));
  await assertListening(
    fixture,
    await fixture.start(
      { CODEX_CLI_PATH: undefined, CODEX_UNIX_SOCKET: undefined },
      undefined,
      true,
    ),
  );
});

for (const value of [undefined, ""]) {
  test(`startup rejects ${value === undefined ? "unset" : "empty"} CODEX_UNIX_SOCKET`, async (t) => {
    const fixture = await setup(t);
    await assertFailure(
      fixture,
      await fixture.start({ CODEX_UNIX_SOCKET: value }),
      /CODEX_UNIX_SOCKET must be set/,
    );
  });
}

for (const type of ["missing", "file", "directory"]) {
  test(`startup rejects a ${type} Unix socket path before listening`, async (t) => {
    const fixture = await setup(t);
    const invalid = path.join(fixture.directory, "invalid socket");
    if (type === "file") fs.writeFileSync(invalid, "");
    if (type === "directory") fs.mkdirSync(invalid);
    await assertFailure(
      fixture,
      await fixture.start({ CODEX_UNIX_SOCKET: invalid }),
      type === "missing"
        ? /does not exist.*app-server is running/
        : /not a Unix domain socket/,
    );
  });
}

for (const mode of [0o000, 0o200, 0o400]) {
  test(
    `startup rejects socket permissions ${mode.toString(8)}`,
    {
      skip: process.getuid() === 0 ? "root bypasses file permissions" : false,
    },
    async (t) => {
      const fixture = await setup(t);
      fs.chmodSync(fixture.socket, mode);
      await assertFailure(
        fixture,
        await fixture.start(),
        /insufficient permissions.*ownership.*read and write/,
      );
    },
  );
}

test(
  "startup reports inaccessible parent directories",
  {
    skip: process.getuid() === 0 ? "root bypasses file permissions" : false,
  },
  async (t) => {
    const fixture = await setup(t);
    const parent = path.join(fixture.directory, "blocked");
    fs.mkdirSync(parent);
    fs.symlinkSync(fixture.socket, path.join(parent, "socket"));
    fs.chmodSync(parent, 0o000);
    try {
      await assertFailure(
        fixture,
        await fixture.start({ CODEX_UNIX_SOCKET: path.join(parent, "socket") }),
        /cannot be accessed.*parent directory search permissions/,
      );
    } finally {
      fs.chmodSync(parent, 0o700);
    }
  },
);

for (const type of ["missing", "non-executable"]) {
  test(`startup rejects a ${type} configured executable`, async (t) => {
    const fixture = await setup(t);
    if (type === "missing") fs.unlinkSync(fixture.proxy);
    else fs.chmodSync(fixture.proxy, 0o644);
    await assertFailure(
      fixture,
      await fixture.start(),
      /CODEX_CLI_PATH.*not an executable file.*chmod \+x/,
    );
  });
}

test("startup with a valid proxy serves HTTP and WebSocket IPC without running websocat", async (t) => {
  const fixture = await setup(t);
  await assertListening(fixture, await fixture.start());
});

test("startup resolves a proxy command from PATH", async (t) => {
  const fixture = await setup(t);
  fs.unlinkSync(path.join(fixture.bin, "websocat"));
  await assertFailure(
    fixture,
    await fixture.start({ CODEX_CLI_PATH: "codex_remote_proxy" }),
    /websocat.*not found in PATH/,
  );
});

test("startup recognizes a symlink to the remote proxy", async (t) => {
  const fixture = await setup(t);
  const alias = path.join(fixture.bin, "proxy-alias");
  fs.symlinkSync(fixture.proxy, alias);
  fs.unlinkSync(path.join(fixture.bin, "websocat"));
  await assertFailure(
    fixture,
    await fixture.start({ CODEX_CLI_PATH: alias }),
    /websocat.*not found in PATH/,
  );
});

test("an explicitly configured proxy wrapper runs the shared preflight", async (t) => {
  const fixture = await setup(t);
  const wrapper = fixture.writeExecutable(
    "custom-proxy",
    'exec "$PROXY_PATH" "$@"',
  );
  fs.unlinkSync(path.join(fixture.bin, "websocat"));
  await assertFailure(
    fixture,
    await fixture.start({
      CODEX_CLI_PATH: wrapper,
      CODEX_CLI_KIND: "remote-proxy",
      PROXY_PATH: fixture.proxy,
    }),
    /websocat.*not found in PATH/,
  );
});

test("a proxy whose preflight hangs fails before listening", async (t) => {
  const fixture = await setup(t);
  // execFile leaves stdin open; read blocks without spawning any subprocesses.
  const wrapper = fixture.writeExecutable("blocked-proxy", "read -r line");
  await assertFailure(
    fixture,
    await fixture.start({
      CODEX_CLI_PATH: wrapper,
      CODEX_CLI_KIND: "remote-proxy",
    }),
    /preflight failed.*validation timed out after 5 seconds/,
  );
});

test("proxy preflight respects dependencies supplied by a wrapper", async (t) => {
  const fixture = await setup(t);
  const dependencies = path.join(fixture.directory, "dependencies");
  fs.mkdirSync(dependencies);
  fs.renameSync(
    path.join(fixture.bin, "websocat"),
    path.join(dependencies, "websocat"),
  );
  const wrapper = fixture.writeExecutable(
    "custom-proxy",
    'export PATH="$DEPENDENCIES:$PATH"\nexec "$PROXY_PATH" "$@"',
  );
  await assertListening(
    fixture,
    await fixture.start({
      CODEX_CLI_PATH: wrapper,
      CODEX_CLI_KIND: "remote-proxy",
      DEPENDENCIES: dependencies,
      PROXY_PATH: fixture.proxy,
    }),
  );
});

for (const form of ["absolute", "relative", "command", "directory"]) {
  test(`a regular CLI (${form} path) does not require websocat or CODEX_UNIX_SOCKET`, async (t) => {
    const fixture = await setup(t);
    fs.unlinkSync(path.join(fixture.bin, "websocat"));
    const cliPath = {
      absolute: fixture.cli,
      relative: "./bin/codex",
      command: "codex",
      directory: fixture.bin,
    }[form];
    await assertListening(
      fixture,
      await fixture.start({
        CODEX_CLI_PATH: cliPath,
        CODEX_UNIX_SOCKET: undefined,
      }),
    );
  });
}

for (const value of [undefined, "", "   "]) {
  test(`startup without an explicit CLI (${JSON.stringify(value)}) preserves upstream discovery`, async (t) => {
    const fixture = await setup(t);
    fs.unlinkSync(path.join(fixture.bin, "websocat"));
    await assertListening(
      fixture,
      await fixture.start({
        CODEX_CLI_PATH: value,
        CODEX_UNIX_SOCKET: undefined,
      }),
    );
  });
}

test("startup reports a CLI command missing from PATH", async (t) => {
  const fixture = await setup(t);
  await assertFailure(
    fixture,
    await fixture.start({ CODEX_CLI_PATH: "missing-codex" }),
    /CODEX_CLI_PATH command.*not found.*PATH/,
  );
});

test("--help does not require a valid proxy configuration", async (t) => {
  const fixture = await setup(t);
  fs.unlinkSync(path.join(fixture.bin, "websocat"));
  const result = await fixture.start({}, ["--help"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.equal(fs.existsSync(fixture.listenLog), false);
});
