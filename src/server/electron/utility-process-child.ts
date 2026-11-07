import { EventEmitter } from "node:events";
import { installModuleAliasHook } from "../module";
import { MessagePortBridge, type PortMessage } from "./message-port";
import type { UtilityPacket } from "./utility-process";

function send(packet: UtilityPacket): void {
  if (process.connected) process.send?.(packet, () => {});
}

class ParentPort extends EventEmitter {
  private readonly pending: PortMessage[] = [];

  receive(message: PortMessage): void {
    if (this.listenerCount("message")) this.emit("message", message);
    else this.pending.push(message);
  }

  override on(event: string, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    if (event === "message")
      queueMicrotask(() => {
        while (this.pending.length && this.listenerCount("message"))
          this.emit("message", this.pending.shift());
      });
    return this;
  }

  postMessage(data: unknown): void {
    send({ type: "utility-message", data, portIds: [] });
  }
}

const parentPort = new ParentPort();
const bridge = new MessagePortBridge(send);
Object.assign(process, { parentPort, type: "utility" });
process.on("message", (packet: UtilityPacket) => {
  if (packet.type === "utility-message")
    parentPort.receive({
      data: packet.data,
      ports: bridge.importPorts(packet.portIds),
    });
  else bridge.receive(packet);
});
process.once("disconnect", () => {
  bridge.close();
  parentPort.emit("close");
  setImmediate(() => process.exit(0));
});

const entrypoint = process.argv[2];
if (!entrypoint) throw new Error("Missing utility process entrypoint");
process.argv.splice(1, 1);
installModuleAliasHook();
require(entrypoint);
