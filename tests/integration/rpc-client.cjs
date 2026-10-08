const WS = require("ws");
async function connect(socketPath) {
  const socket = new WS(`ws+unix://${socketPath}:/`, {
    maxPayload: 100 * 1024 * 1024,
  });
  let counter = 0;
  const pending = new Map();
  socket.on("message", (data) => {
    const msg = JSON.parse(data);
    const p = pending.get(msg.id);
    if (p && !msg.method) {
      clearTimeout(p.timer);
      pending.delete(msg.id);
      p.resolve(msg);
    }
  });
  socket.on("close", () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("RPC socket closed"));
    }
    pending.clear();
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++counter;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  const init = await request("initialize", {
    clientInfo: { name: "codex_shared_diagnostics", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  if (init.error) {
    socket.close();
    throw new Error(init.error.message);
  }
  socket.send(JSON.stringify({ method: "initialized" }));
  return { socket, request, init, close: () => socket.close() };
}
module.exports = { connect };
