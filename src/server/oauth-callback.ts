import http from "node:http";

const CALLBACK_PATH = "/auth/callback";
const CALLBACK_PORTS = new Set([1455, 1457]);
const LOOPBACK_HOSTS = ["::1", "127.0.0.1"] as const;
const MAX_CALLBACK_LENGTH = 16_384;

export type RemoteControlOAuthCallback = {
  path: typeof CALLBACK_PATH;
  port: number;
  search: string;
};

export function parseRemoteControlOAuthCallbackUrl(
  value: unknown,
): RemoteControlOAuthCallback {
  if (typeof value !== "string" || value.length > MAX_CALLBACK_LENGTH) {
    throw new Error("Invalid remote-control OAuth callback URL");
  }

  let callbackUrl: URL;
  try {
    callbackUrl = new URL(value.trim());
  } catch {
    throw new Error("Invalid remote-control OAuth callback URL");
  }

  if (
    callbackUrl.protocol !== "http:" ||
    callbackUrl.hostname !== "localhost" ||
    !CALLBACK_PORTS.has(Number(callbackUrl.port)) ||
    callbackUrl.pathname !== CALLBACK_PATH ||
    callbackUrl.username !== "" ||
    callbackUrl.password !== "" ||
    callbackUrl.hash !== ""
  ) {
    throw new Error("Unsupported remote-control OAuth callback URL");
  }

  const state = callbackUrl.searchParams.get("state");
  const code = callbackUrl.searchParams.get("code");
  const error = callbackUrl.searchParams.get("error");
  if (!state) {
    throw new Error("Remote-control OAuth callback is missing state");
  }
  if (!code && !error) {
    throw new Error("Remote-control OAuth callback is missing a result");
  }

  return {
    path: CALLBACK_PATH,
    port: Number(callbackUrl.port),
    search: callbackUrl.search,
  };
}

export async function forwardRemoteControlOAuthCallback(
  callback: RemoteControlOAuthCallback,
  options: {
    hosts?: readonly string[];
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const hosts = options.hosts ?? LOOPBACK_HOSTS;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let lastError: unknown;

  for (const host of hosts) {
    try {
      await new Promise<void>((resolve, reject) => {
        const request = http.request(
          {
            headers: {
              Connection: "close",
              Host: `localhost:${callback.port}`,
            },
            host,
            method: "GET",
            path: `${callback.path}${callback.search}`,
            port: callback.port,
          },
          (response) => {
            response.resume();
            response.once("end", () => {
              const statusCode = response.statusCode ?? 500;
              if (statusCode >= 200 && statusCode < 300) {
                resolve();
                return;
              }
              reject(
                new Error(
                  `Remote-control OAuth callback was rejected (${statusCode})`,
                ),
              );
            });
          },
        );

        request.setTimeout(timeoutMs, () => {
          request.destroy(new Error("Remote-control OAuth callback timed out"));
        });
        request.once("error", reject);
        request.end();
      });
      return;
    } catch (error) {
      lastError = error;
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : null;
      if (!new Set(["EADDRNOTAVAIL", "ECONNREFUSED"]).has(code ?? "")) {
        throw error;
      }
    }
  }

  throw (
    lastError ??
    new Error(
      `No loopback OAuth listener is available on port ${callback.port}`,
    )
  );
}
