import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  forwardRemoteControlOAuthCallback,
  parseRemoteControlOAuthCallbackUrl,
} from "../src/server/oauth-callback.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("accepts only expected localhost callback URLs", () => {
  assert.deepEqual(
    parseRemoteControlOAuthCallbackUrl(
      "http://localhost:1455/auth/callback?code=test-code&state=test-state",
    ),
    {
      path: "/auth/callback",
      port: 1455,
      search: "?code=test-code&state=test-state",
    },
  );
  assert.deepEqual(
    parseRemoteControlOAuthCallbackUrl(
      "http://localhost:1457/auth/callback?error=access_denied&state=test-state",
    ),
    {
      path: "/auth/callback",
      port: 1457,
      search: "?error=access_denied&state=test-state",
    },
  );

  for (const value of [
    "https://localhost:1455/auth/callback?code=test&state=test",
    "http://127.0.0.1:1455/auth/callback?code=test&state=test",
    "http://example.test:1455/auth/callback?code=test&state=test",
    "http://user@localhost:1455/auth/callback?code=test&state=test",
    "http://localhost:1455/not-the-callback?code=test&state=test",
    "http://localhost:8080/auth/callback?code=test&state=test",
    "http://localhost:1455/auth/callback?code=test&state=test#fragment",
    "http://localhost:1455/auth/callback?code=test",
    "http://localhost:1455/auth/callback?state=test",
    null,
  ]) {
    assert.throws(
      () => parseRemoteControlOAuthCallbackUrl(value),
      /remote-control OAuth callback/iu,
    );
  }
});

test("forwards a validated callback only to a loopback listener", async () => {
  let receivedUrl = null;
  let receivedHost = null;
  const callbackServer = http.createServer((request, response) => {
    receivedUrl = request.url;
    receivedHost = request.headers.host;
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
  });
  await listen(callbackServer);

  try {
    const address = callbackServer.address();
    assert(address && typeof address === "object");
    await forwardRemoteControlOAuthCallback(
      {
        path: "/auth/callback",
        port: address.port,
        search: "?code=test-code&state=test-state",
      },
      { hosts: ["127.0.0.1"] },
    );
    assert.equal(receivedHost, `localhost:${address.port}`);
    assert.equal(receivedUrl, "/auth/callback?code=test-code&state=test-state");
  } finally {
    await close(callbackServer);
  }
});

test("does not include callback parameters in forwarding errors", async () => {
  const callbackServer = http.createServer((_request, response) => {
    response.writeHead(400);
    response.end("rejected");
  });
  await listen(callbackServer);

  try {
    const address = callbackServer.address();
    assert(address && typeof address === "object");
    await assert.rejects(
      forwardRemoteControlOAuthCallback(
        {
          path: "/auth/callback",
          port: address.port,
          search: "?code=must-not-appear&state=test-state",
        },
        { hosts: ["127.0.0.1"] },
      ),
      (error) => {
        assert(error instanceof Error);
        assert.match(error.message, /rejected \(400\)/u);
        assert.doesNotMatch(error.message, /must-not-appear/u);
        return true;
      },
    );
  } finally {
    await close(callbackServer);
  }
});
