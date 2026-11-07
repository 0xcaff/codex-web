import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { MessageChannel, MessagePort } from "node:worker_threads";

export type PortMessage = { data: unknown; ports: MessagePortMain[] };
type NativeMessage = { data: unknown; ports: MessagePort[] };

/** Electron's EventEmitter interface around a transferable Node MessagePort. */
export class MessagePortMain extends EventEmitter {
  private started = false;
  private closed = false;

  constructor(private readonly port: MessagePort) {
    super();
    port.on("close", () => this.finish());
    port.unref();
  }

  postMessage(data: unknown, ports: MessagePortMain[] = []): void {
    if (this.closed) return;
    const transferred = ports.map((p) => p.detach());
    this.port.postMessage({ data, ports: transferred }, transferred);
  }

  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    this.port.on("message", ({ data, ports }: NativeMessage) => {
      this.emit("message", {
        data,
        ports: ports.map((p) => new MessagePortMain(p)),
      });
    });
    this.port.unref();
  }

  close(): void {
    if (this.closed) return;
    this.port.close();
    this.finish();
  }

  /** Move ownership; Node retains messages queued before start(). */
  detach(): MessagePort {
    if (this.closed) throw new Error("Cannot transfer a closed MessagePort");
    this.closed = true;
    this.port.removeAllListeners();
    this.removeAllListeners();
    return this.port;
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
    this.removeAllListeners();
  }
}

export class MessageChannelMain {
  readonly port1: MessagePortMain;
  readonly port2: MessagePortMain;
  constructor() {
    const channel = new MessageChannel();
    this.port1 = new MessagePortMain(channel.port1);
    this.port2 = new MessagePortMain(channel.port2);
  }
}

export type PortPacket =
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
      portIds: string[];
    }
  | { type: "message-port-close"; portId: string };

/** Relay transferred endpoints over transports that cannot transfer native ports. */
export class MessagePortBridge {
  private readonly ports = new Map<string, MessagePortMain>();

  constructor(private readonly send: (packet: PortPacket) => void) {}

  exportPorts(ports: MessagePortMain[]): string[] {
    return ports.map((port) => {
      const id = randomUUID();
      this.bind(id, new MessagePortMain(port.detach()));
      return id;
    });
  }

  importPorts(ids: string[]): MessagePortMain[] {
    return ids.map((id) => {
      if (this.ports.has(id))
        throw new Error("Duplicate transferred MessagePort id");
      const channel = new MessageChannelMain();
      this.bind(id, channel.port1);
      return channel.port2;
    });
  }

  receive(packet: PortPacket): void {
    const port = this.ports.get(packet.portId);
    if (!port) return;
    if (packet.type === "message-port-close") {
      this.ports.delete(packet.portId);
      port.close();
    } else {
      port.postMessage(packet.data, this.importPorts(packet.portIds));
    }
  }

  close(): void {
    const ports = [...this.ports.values()];
    this.ports.clear();
    for (const port of ports) port.close();
  }

  private bind(id: string, port: MessagePortMain): void {
    this.ports.set(id, port);
    port.on("message", ({ data, ports }: PortMessage) => {
      this.send({
        type: "message-port-message",
        portId: id,
        data,
        portIds: this.exportPorts(ports),
      });
    });
    port.once("close", () => {
      if (this.ports.delete(id))
        this.send({ type: "message-port-close", portId: id });
    });
    port.start();
  }
}
