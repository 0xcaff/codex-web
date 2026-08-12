export function mapBrowserPathToInitialRoute(pathname: string, search: string) {
  if (pathname === "/share/receive" && search) {
    const params = new URLSearchParams(search);

    const prompt = ["title", "text", "url"]
      .flatMap((name) => {
        const value = params.get(name);
        return value === null ? [] : [`${name}: ${value}`];
      })
      .join("\n");

    return {
      memoryPath: prompt
        ? `/?${new URLSearchParams({ prompt }).toString()}`
        : "/",
      browserPath: "/",
    };
  }

  return {
    memoryPath: mapBrowserPathToRoute(pathname),
  };
}

function mapBrowserPathToRoute(pathname: string): string {
  const threadId = pathname.match(/^\/thread\/([^/]+)$/)?.[1];
  if (threadId) {
    try {
      return `/local/${decodeURIComponent(threadId)}`;
    } catch {
      return "/";
    }
  }

  return "/";
}

export function mapMemoryPathToBrowserPath(pathname: string) {
  if (pathname === "/") {
    return { path: "/", titleChange: "Codex" };
  }

  const threadId = pathname.match(/^\/local\/([^/?#]+)$/)?.[1];
  if (!threadId) {
    return null;
  }

  return { path: `/thread/${encodeURIComponent(threadId)}` };
}

export function dispatchNavigateToRoute(path: string): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "navigate-to-route",
        path,
      },
    }),
  );
}

window.addEventListener("popstate", () => {
  dispatchNavigateToRoute(mapBrowserPathToRoute(window.location.pathname));
});
