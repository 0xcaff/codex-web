import type { ServerOptions } from "ws";
import type { FastifyStaticOptions } from "@fastify/static";

// Keep file downloads and the live IPC connection independent. Only the
// packaged webview assets use the prebuilt compressed representations.
export const WEBVIEW_STATIC_OPTIONS: Pick<
  FastifyStaticOptions,
  "preCompressed" | "setHeaders"
> = {
  preCompressed: true,
  setHeaders(response): void {
    response.setHeader("Vary", "Accept-Encoding");
  },
};

export const BROWSER_SOCKET_OPTIONS: ServerOptions = {
  noServer: true,
  perMessageDeflate: {
    threshold: 1024,
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    concurrencyLimit: 4,
    zlibDeflateOptions: { level: 3 },
  },
};
