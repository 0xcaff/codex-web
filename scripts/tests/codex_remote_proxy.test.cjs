// Run with: node --test scripts/tests/codex_remote_proxy.test.cjs
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const script = path.resolve(__dirname, "../codex_remote_proxy");
const bash = execFileSync("bash", ["-c", 'printf "%s" "$BASH"'], {
  encoding: "utf8",
});

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-"));
  const bin = path.join(directory, "bin");
  const socket = path.join(directory, "control socket.sock");
  const log = path.join(directory, "arguments");
  const server = net.createServer();
  t.after(async () => {
    try {
      if (server.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "websocat"),
    `#!${bash}\nprintf '%s\\0' "$@" > "$WEBSOCAT_ARGS_LOG"\nexit "\${WEBSOCAT_EXIT_CODE:-0}"\n`,
    { mode: 0o755 },
  );
  server.listen(socket);
  await once(server, "listening");

  return {
    bin,
    directory,
    log,
    socket,
    run(environment = {}, args = ["app-server"]) {
      const result = spawnSync(bash, [script, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: bin,
          CODEX_UNIX_SOCKET: socket,
          CODEX_BUFFER_SIZE: undefined,
          WEBSOCAT_ARGS_LOG: log,
          WEBSOCAT_EXIT_CODE: undefined,
          ...environment,
        },
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      return result;
    },
  };
}

function assertFailure(fixture, result, status, message) {
  assert.equal(result.status, status);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, message);
  assert.equal(fs.existsSync(fixture.log), false, "websocat must not execute");
}

function assertForwarding(fixture, result, bufferSize) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(
    fs.readFileSync(fixture.log, "utf8").split("\0").slice(0, -1),
    ["-E", "-t", "-B", bufferSize, "-", `ws-c:unix:${fixture.socket}`],
  );
}

test("missing websocat reports the dependency and installation guidance", async (t) => {
  const fixture = await setup(t);
  fs.unlinkSync(path.join(fixture.bin, "websocat"));
  const result = fixture.run();
  assertFailure(
    fixture,
    result,
    127,
    /websocat.*not found in PATH.*Install websocat/,
  );
});

for (const value of [undefined, ""]) {
  test(`CODEX_UNIX_SOCKET ${value === undefined ? "unset" : "empty"} reports how to configure it`, async (t) => {
    const fixture = await setup(t);
    assertFailure(
      fixture,
      fixture.run({ CODEX_UNIX_SOCKET: value }),
      78,
      /CODEX_UNIX_SOCKET must be set to the app-server control Unix socket path/,
    );
  });
}

test("missing socket reports its path and how to resolve it", async (t) => {
  const fixture = await setup(t);
  const missing = path.join(fixture.directory, "missing.sock");
  const result = fixture.run({ CODEX_UNIX_SOCKET: missing });
  assertFailure(fixture, result, 69, /does not exist.*app-server is running/);
  assert.ok(result.stderr.includes(missing));
  assert.equal(
    fs.existsSync(missing),
    false,
    "the proxy must not create a socket",
  );
});

for (const type of ["file", "directory"]) {
  test(`a ${type} is rejected as a non-socket path`, async (t) => {
    const fixture = await setup(t);
    const nonSocket = path.join(fixture.directory, "not a socket");
    if (type === "file") fs.writeFileSync(nonSocket, "");
    else fs.mkdirSync(nonSocket);
    const result = fixture.run({ CODEX_UNIX_SOCKET: nonSocket });
    assertFailure(
      fixture,
      result,
      78,
      /not a Unix domain socket.*app-server control/,
    );
    assert.ok(result.stderr.includes(nonSocket));
  });
}

for (const mode of [0o000, 0o200, 0o400]) {
  test(
    `socket permissions ${mode.toString(8)} are rejected`,
    {
      skip: process.getuid() === 0 ? "root bypasses file permissions" : false,
    },
    async (t) => {
      const fixture = await setup(t);
      fs.chmodSync(fixture.socket, mode);
      const result = fixture.run();
      assertFailure(
        fixture,
        result,
        77,
        /insufficient permissions.*ownership.*read and write/,
      );
      assert.ok(result.stderr.includes(fixture.socket));
    },
  );
}

for (const bufferSize of [undefined, "", "2048"]) {
  test(`a valid socket forwards the expected arguments with buffer ${JSON.stringify(bufferSize)}`, async (t) => {
    const fixture = await setup(t);
    assertForwarding(
      fixture,
      fixture.run({ CODEX_BUFFER_SIZE: bufferSize }),
      bufferSize || "104857600",
    );
  });
}

test("leading -c pairs and remaining app-server arguments are ignored", async (t) => {
  const fixture = await setup(t);
  assertForwarding(
    fixture,
    fixture.run({}, [
      "-c",
      "key=value",
      "-c",
      "other=value",
      "app-server",
      "--ignored",
    ]),
    "104857600",
  );
});

for (const args of [[], ["other-mode"], ["-c"]]) {
  test(`invalid invocation ${JSON.stringify(args)} retains its usage error`, async (t) => {
    const fixture = await setup(t);
    assertFailure(
      fixture,
      fixture.run({}, args),
      64,
      args[0] === "-c"
        ? /received -c without a value/
        : /only supports app-server mode/,
    );
  });
}

test("the proxy preserves the websocat exit status", async (t) => {
  const fixture = await setup(t);
  const result = fixture.run({ WEBSOCAT_EXIT_CODE: "42" });
  assert.equal(result.status, 42);
  assert.equal(result.stderr, "");
  assert.ok(fs.existsSync(fixture.log));
});
