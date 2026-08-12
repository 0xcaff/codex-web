import process from "node:process";

const operatorStdout = process.stdout.write.bind(process.stdout);
const operatorStderr = process.stderr.write.bind(process.stderr);
const noop = (): void => undefined;
let installed = false;

export function operatorLog(message: string): void {
  operatorStdout(`${message}\n`);
}

export function operatorWarn(category: string): void {
  operatorStderr(`${category}\n`);
}

export function operatorError(category: string): void {
  operatorStderr(`${category}\n`);
}

export function operatorDebug(message: string): void {
  if (process.env.CODEX_WEB_DEBUG === "1") {
    operatorStderr(`${message}\n`);
  }
}

/** Suppress the extracted Desktop bundle's payload-bearing console output. */
export function installUpstreamConsolePolicy(): void {
  if (installed) return;
  installed = true;
  console.log = noop;
  console.info = noop;
  console.debug = noop;
  console.warn = noop;
  console.error = noop;
}
