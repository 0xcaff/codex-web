import { fork, type ForkOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import {
  MessagePortBridge,
  type MessagePortMain,
  type PortPacket,
} from "./message-port";

export type UtilityPacket =
  | PortPacket
  | {
      type: "utility-message";
      data: unknown;
      portIds: string[];
    };

type UtilityOptions = Pick<ForkOptions, "cwd" | "env" | "execArgv"> & {
  serviceName?: string;
  stdio?: "pipe" | "ignore" | "inherit";
};

class UtilityProcess extends EventEmitter {
  private readonly child;
  private readonly bridge;
  private exited = false;

  constructor(modulePath: string, args: string[], options: UtilityOptions) {
    super();
    const output = options.stdio ?? "inherit";
    this.child = fork(
      path.join(__dirname, "utility-process-child.js"),
      [path.resolve(modulePath), ...args],
      {
        cwd: options.cwd,
        env: options.env,
        execArgv: options.execArgv ?? [],
        serialization: "advanced",
        stdio: ["ignore", output, output, "ipc"],
      },
    );
    this.bridge = new MessagePortBridge((packet) => this.send(packet));
    this.child.on("message", (packet: UtilityPacket) => {
      if (packet.type === "utility-message") this.emit("message", packet.data);
      else this.bridge.receive(packet);
    });
    this.child.on("spawn", () => this.emit("spawn"));
    this.child.on("error", (error) => this.emit("error", error));
    this.child.on("disconnect", () => this.bridge.close());
    this.child.on("exit", (code) => {
      this.exited = true;
      this.bridge.close();
      this.emit("exit", code ?? -1);
    });
  }

  get pid(): number | undefined {
    return this.exited ? undefined : this.child.pid;
  }
  get stdout() {
    return this.child.stdout;
  }
  get stderr() {
    return this.child.stderr;
  }
  kill(): boolean {
    return this.child.kill();
  }

  postMessage(data: unknown, ports: MessagePortMain[] = []): void {
    if (!this.child.connected) return;
    this.send({
      type: "utility-message",
      data,
      portIds: this.bridge.exportPorts(ports),
    });
  }

  private send(packet: UtilityPacket): void {
    if (!this.child.connected) return;
    this.child.send(packet, (error) => {
      if (error && this.child.connected) this.emit("error", error);
    });
  }
}

export const utilityProcess = {
  fork(
    modulePath: string,
    args: string[] = [],
    options: UtilityOptions = {},
  ): UtilityProcess {
    return new UtilityProcess(modulePath, args, options);
  },
};
