import type { ChildProcess } from "node:child_process";

type Spawn = typeof import("node:child_process").spawn;

const childProcessModule =
  require("node:child_process") as typeof import("node:child_process");
const mutableChildProcessModule = childProcessModule as { spawn: Spawn };
const originalSpawn = childProcessModule.spawn;
const trackedChildren = new Set<ChildProcess>();
let installed = false;

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!isRunning(child)) return Promise.resolve();

  return new Promise((resolve) => {
    const timeout = setTimeout(finish, timeoutMs);
    const onExit = () => finish();
    function finish(): void {
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      resolve();
    }
    child.once("exit", onExit);
  });
}

/** Track processes created by the extracted Desktop app after bootstrap. */
export function installUpstreamProcessTracker(): void {
  if (installed) return;
  installed = true;

  mutableChildProcessModule.spawn = ((...args: unknown[]) => {
    const child = Reflect.apply(
      originalSpawn,
      childProcessModule,
      args,
    ) as ChildProcess;
    trackedChildren.add(child);
    const forget = () => trackedChildren.delete(child);
    child.once("error", forget);
    child.once("exit", forget);
    return child;
  }) as Spawn;
}

/** Terminate tracked upstream children, escalating after a short grace period. */
export async function terminateUpstreamProcesses(): Promise<void> {
  const children = [...trackedChildren].filter(isRunning);
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(children.map((child) => waitForExit(child, 1_000)));

  const remaining = children.filter(isRunning);
  for (const child of remaining) child.kill("SIGKILL");
  await Promise.all(remaining.map((child) => waitForExit(child, 500)));
}

/** Synchronous last resort used when an operator sends a second signal. */
export function forceTerminateUpstreamProcesses(): void {
  for (const child of trackedChildren) {
    if (isRunning(child)) child.kill("SIGKILL");
  }
}
