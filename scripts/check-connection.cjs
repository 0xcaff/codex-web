#!/usr/bin/env node
const WebSocket = require("ws");

let target;
try {
  target = new URL(process.argv[2] || "http://127.0.0.1:8214");
  if (!["http:", "https:"].includes(target.protocol))
    throw new Error("Use an http:// or https:// URL");
  if (target.username || target.password)
    throw new Error("Do not put credentials in the URL");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const endpoint = new URL("/__backend/ipc", target);
endpoint.protocol = target.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(endpoint, { handshakeTimeout: 15000 });
let finished = false;
socket.on("open", () => {
  finished = true;
  console.log("OK: WebSocket upgrade returned 101.");
  console.log("Compression: " + (socket.extensions || "not negotiated"));
  socket.close();
});
socket.on("unexpected-response", (_request, response) => {
  finished = true;
  console.error(
    "WebSocket upgrade failed: HTTP " +
      response.statusCode +
      " (expected 101).",
  );
  if (response.statusCode === 200) {
    console.error(
      "The endpoint returned an ordinary page. Check the reverse proxy route, HTTP/1.1, Upgrade and Connection headers.",
    );
  } else if ([301, 302, 307, 308, 401, 403].includes(response.statusCode)) {
    console.error(
      "Check proxy redirects and authentication; this probe does not use browser login cookies.",
    );
  }
  response.resume();
  process.exitCode = 1;
  socket.terminate();
});
socket.on("error", (error) => {
  if (finished) return;
  finished = true;
  console.error("Connection failed: " + error.message);
  process.exitCode = 1;
});
