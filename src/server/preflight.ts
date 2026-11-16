import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function isExecutable(file: string): Promise<boolean> {
  try {
    if (!(await fs.stat(file)).isFile()) return false;
    await fs.access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutable(configured: string): Promise<string> {
  if (/[\\/]/.test(configured) || path.isAbsolute(configured)) {
    let executable = path.resolve(configured);
    try {
      // The upstream resolver also accepts a directory containing `codex`.
      if ((await fs.stat(executable)).isDirectory()) {
        executable = path.join(executable, "codex");
      }
    } catch {
      // Report missing paths and inaccessible parent directories below.
    }
    if (await isExecutable(executable)) return executable;
    throw new Error(
      `CODEX_CLI_PATH '${configured}' is missing, inaccessible, or not an executable file. Verify the path and parent directory search permissions, and grant execute permission (chmod +x) to '${executable}'.`,
    );
  }

  for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(
    path.delimiter,
  )) {
    const executable = path.resolve(directory, configured);
    if (await isExecutable(executable)) return executable;
  }
  throw new Error(
    `CODEX_CLI_PATH command '${configured}' was not found as an executable file in PATH. Install it, grant execute permission, or set CODEX_CLI_PATH to its full executable path.`,
  );
}

export async function validateCodexExecutable(): Promise<void> {
  const configured = process.env.CODEX_CLI_PATH?.trim();
  if (!configured) return;

  const executable = await resolveExecutable(configured);
  const realExecutable = await fs.realpath(executable);
  const isProxy =
    path.basename(executable) === "codex_remote_proxy" ||
    path.basename(realExecutable) === "codex_remote_proxy" ||
    process.env.CODEX_CLI_KIND === "remote-proxy";
  if (!isProxy) return;

  try {
    // Let the proxy validate its own runtime environment (including wrapper PATH
    // additions) and reuse the defensive checks it performs for app-server.
    await execFileAsync(executable, ["--preflight"], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    const failure = error as Error & {
      stderr?: string;
      killed?: boolean;
      signal?: NodeJS.Signals;
    };
    const diagnostic =
      failure.killed && failure.signal === "SIGTERM"
        ? "validation timed out after 5 seconds"
        : failure.stderr?.trim() || failure.message;
    throw new Error(
      `Codex proxy preflight failed for '${executable}': ${diagnostic}\nThe proxy must support --preflight and exit without starting app-server or websocat.`,
    );
  }
}
