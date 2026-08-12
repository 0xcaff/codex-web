import path from "node:path";

export type ElectronPathName =
  | "appData"
  | "desktop"
  | "documents"
  | "downloads"
  | "home"
  | "temp"
  | "userData";

type Platform = "darwin" | "linux";

export type ElectronPathEnvironment = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  platform: Platform;
  readFile: (path: string) => string | undefined;
  tempDir: string;
};

const userDirectoryNames = {
  desktop: "XDG_DESKTOP_DIR",
  documents: "XDG_DOCUMENTS_DIR",
  downloads: "XDG_DOWNLOAD_DIR",
} as const;

function xdgConfigHome(environment: ElectronPathEnvironment): string {
  const configuredPath = environment.env.XDG_CONFIG_HOME;
  return configuredPath && path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(environment.homeDir, ".config");
}

function parseXdgUserDirectory(
  contents: string | undefined,
  variableName: string,
  homeDir: string,
): string | undefined {
  if (!contents) {
    return undefined;
  }

  const line = contents
    .split(/\r?\n/)
    .find((candidate) => candidate.trimStart().startsWith(`${variableName}=`));
  if (!line) {
    return undefined;
  }

  const value = line.slice(line.indexOf("=") + 1).trim();
  const unquoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
      ? value.slice(1, -1)
      : value;
  const expanded = unquoted
    .replace(/\$\{HOME\}/g, homeDir)
    .replace(/\$HOME/g, homeDir)
    .replace(/\\([\\"$])/g, "$1");

  if (!expanded || expanded.includes("$")) {
    return undefined;
  }

  return path.isAbsolute(expanded) ? expanded : path.resolve(homeDir, expanded);
}

/**
 * Mirrors Electron's commonly used user paths without performing I/O.
 */
export class ElectronPathResolver {
  private readonly overrides = new Map<string, string>();

  constructor(private readonly environment: ElectronPathEnvironment) {}

  getPath(name: string): string {
    const override = this.overrides.get(name);
    if (override) {
      return override;
    }

    const { homeDir, platform, tempDir } = this.environment;
    switch (name as ElectronPathName) {
      case "home":
        return homeDir;
      case "temp":
        return tempDir;
      case "appData":
        return platform === "darwin"
          ? path.join(homeDir, "Library", "Application Support")
          : xdgConfigHome(this.environment);
      case "userData":
        return path.join(this.getPath("appData"), "codex-web");
      case "desktop":
      case "documents":
      case "downloads": {
        if (platform !== "linux") {
          return path.join(homeDir, name[0]!.toUpperCase() + name.slice(1));
        }
        const userDirectoryName =
          userDirectoryNames[name as keyof typeof userDirectoryNames];
        const xdgPath = parseXdgUserDirectory(
          this.environment.readFile(
            path.join(xdgConfigHome(this.environment), "user-dirs.dirs"),
          ),
          userDirectoryName,
          homeDir,
        );
        return (
          xdgPath ?? path.join(homeDir, name[0]!.toUpperCase() + name.slice(1))
        );
      }
      default:
        throw new Error(`Unsupported Electron path name: ${name}`);
    }
  }

  setPath(name: string, value: string): void {
    if (!path.isAbsolute(value)) {
      throw new Error(
        `Electron path override for ${name} must be absolute: ${value}`,
      );
    }
    this.overrides.set(name, value);
  }
}
