import process from "node:process";

const operatorStdout = process.stdout.write.bind(process.stdout);
const operatorStderr = process.stderr.write.bind(process.stderr);
const noop = (): void => undefined;
let installed = false;
let upstreamWarningReported = false;
let upstreamErrorReported = false;

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
  // The upstream structured logger reads this during module initialization.
  // Force the strictest supported level; caller overrides would invalidate the
  // operator promise that routine payload-bearing logs remain contained.
  process.env.CODEX_MAX_LOG_LEVEL = "error";
  if (installed) return;
  installed = true;
  console.log = noop;
  console.info = noop;
  console.debug = noop;
  console.warn = (): void => {
    if (upstreamWarningReported) return;
    upstreamWarningReported = true;
    operatorStderr("[upstream] warning suppressed\n");
  };
  console.error = (): void => {
    if (upstreamErrorReported) return;
    upstreamErrorReported = true;
    operatorStderr("[upstream] error suppressed\n");
  };
}
