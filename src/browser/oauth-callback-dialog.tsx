import React, { FormEvent, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

const DIALOG_ID = "codex-web-remote-control-oauth-dialog";
const TITLE_ID = `${DIALOG_ID}-title`;
const DESCRIPTION_ID = `${DIALOG_ID}-description`;

type RemoteControlOAuthDialogProps = {
  authorizationUrl: string;
  onClose: () => void;
  onSubmit: (callbackUrl: string) => Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRemoteControlAuthorizationUrl(value: string): boolean {
  let authorizationUrl: URL;
  try {
    authorizationUrl = new URL(value);
  } catch {
    return false;
  }

  if (
    authorizationUrl.protocol !== "https:" ||
    authorizationUrl.hostname !== "auth.openai.com" ||
    authorizationUrl.pathname !== "/oauth/authorize" ||
    authorizationUrl.username !== "" ||
    authorizationUrl.password !== ""
  ) {
    return false;
  }

  const scopes = authorizationUrl.searchParams.get("scope")?.split(/\s+/u);
  if (!scopes?.includes("codex.remote_control.enroll")) {
    return false;
  }

  const redirectValue = authorizationUrl.searchParams.get("redirect_uri");
  if (!redirectValue) {
    return false;
  }

  try {
    const redirectUrl = new URL(redirectValue);
    return (
      redirectUrl.protocol === "http:" &&
      redirectUrl.hostname === "localhost" &&
      new Set(["1455", "1457"]).has(redirectUrl.port) &&
      redirectUrl.pathname === "/auth/callback" &&
      redirectUrl.username === "" &&
      redirectUrl.password === "" &&
      redirectUrl.search === "" &&
      redirectUrl.hash === ""
    );
  } catch {
    return false;
  }
}

function RemoteControlOAuthDialog({
  authorizationUrl,
  onClose,
  onSubmit,
}: RemoteControlOAuthDialogProps): React.ReactElement {
  const [callbackUrl, setCallbackUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const authorizationLinkRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    authorizationLinkRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await onSubmit(callbackUrl.trim());
      setCallbackUrl("");
      onClose();
    } catch (submitError) {
      setError(errorMessage(submitError));
      setIsSubmitting(false);
    }
  }

  const stopPropagation = (event: React.SyntheticEvent): void => {
    event.stopPropagation();
  };

  return (
    <div
      aria-describedby={DESCRIPTION_ID}
      aria-labelledby={TITLE_ID}
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={stopPropagation}
      onFocus={stopPropagation}
      onMouseDown={stopPropagation}
      onPointerDown={stopPropagation}
      role="dialog"
      style={{ pointerEvents: "auto" }}
    >
      <form
        className="bg-token-dropdown-background text-token-foreground ring-token-border w-full max-w-xl rounded-3xl p-6 shadow-lg ring-[0.5px]"
        onSubmit={handleSubmit}
      >
        <h2 className="heading-dialog font-semibold" id={TITLE_ID}>
          Complete remote-control authorization
        </h2>
        <p
          className="text-token-text-secondary mt-2 text-sm leading-6"
          id={DESCRIPTION_ID}
        >
          Open the authorization page, finish signing in, and copy the complete
          localhost URL from the redirected tab. Return here and paste it below.
          Do not paste the URL into chat.
        </p>

        <a
          className="bg-token-foreground text-token-dropdown-background mt-4 inline-flex rounded-lg px-4 py-2 text-sm font-medium"
          href={authorizationUrl}
          ref={authorizationLinkRef}
          rel="noopener noreferrer"
          target="_blank"
        >
          Open authorization page
        </a>

        <label className="mt-5 flex flex-col gap-2 text-sm font-medium">
          OpenAI localhost callback URL
          <textarea
            autoComplete="off"
            autoFocus={false}
            className="border-token-input-border bg-token-input-background text-token-input-foreground min-h-28 rounded-lg border p-3 font-mono text-xs outline-none"
            disabled={isSubmitting}
            onChange={(event) => setCallbackUrl(event.target.value)}
            placeholder="http://localhost:1455/auth/callback?code=…&state=…"
            required
            rows={4}
            spellCheck={false}
            value={callbackUrl}
          />
        </label>

        {error ? (
          <p aria-live="polite" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-3">
          <button
            className="border-token-border rounded-lg border px-4 py-2 text-sm"
            disabled={isSubmitting}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="bg-token-foreground text-token-dropdown-background rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
            disabled={isSubmitting || callbackUrl.trim() === ""}
            type="submit"
          >
            {isSubmitting ? "Completing…" : "Complete authorization"}
          </button>
        </div>
      </form>
    </div>
  );
}

let activeRoot: Root | null = null;
let activeHost: HTMLElement | null = null;

function closeActiveDialog(): void {
  activeRoot?.unmount();
  activeHost?.remove();
  activeRoot = null;
  activeHost = null;
}

function createHost(): HTMLElement {
  closeActiveDialog();

  const host = document.createElement("div");
  host.id = DIALOG_ID;
  const dialogs = document.querySelectorAll<HTMLElement>(
    '[role="dialog"][aria-modal="true"]',
  );
  const activeDialog = dialogs.item(dialogs.length - 1);
  (activeDialog ?? document.body).append(host);
  return host;
}

export function openRemoteControlOAuthDialog(
  options: Omit<RemoteControlOAuthDialogProps, "onClose">,
): void {
  const activeElement = document.activeElement;
  const host = createHost();
  const root = createRoot(host);
  activeHost = host;
  activeRoot = root;

  const close = (): void => {
    closeActiveDialog();
    if (activeElement instanceof HTMLElement) {
      activeElement.focus();
    }
  };

  root.render(<RemoteControlOAuthDialog {...options} onClose={close} />);
}
