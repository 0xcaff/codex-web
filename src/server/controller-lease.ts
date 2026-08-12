/**
 * A deliberately small single-host arbitration mechanism. This is not user
 * authentication: it only prevents two browser tabs from concurrently sending
 * state-changing IPC to the one upstream Electron process.
 */
export const CONTROLLER_HEARTBEAT_MS = 5_000;
export const CONTROLLER_LEASE_MS = 15_000;
export const CONTROLLER_RECONNECT_GRACE_MS = 5_000;

export type ControllerLeaseStatus = "active" | "secondary";

export type Clock = () => number;

export class ControllerLeaseManager {
  private controllerClientId: string | null = null;
  private leaseExpiresAt = 0;
  private readonly connectedClients = new Set<string>();

  constructor(private readonly now: Clock = Date.now) {}

  connect(clientId: string): ControllerLeaseStatus {
    this.expireStaleLease();
    this.connectedClients.add(clientId);
    if (!this.controllerClientId) this.grant(clientId);
    return this.statusFor(clientId);
  }

  disconnect(clientId: string): void {
    this.connectedClients.delete(clientId);
    if (this.controllerClientId === clientId) {
      // Keep the lease briefly to prevent a background socket close from
      // handing control to another tab while the controller reconnects.
      this.leaseExpiresAt = Math.min(
        this.leaseExpiresAt,
        this.now() + CONTROLLER_RECONNECT_GRACE_MS,
      );
    }
  }

  heartbeat(clientId: string): ControllerLeaseStatus {
    this.expireStaleLease();
    this.connectedClients.add(clientId);
    if (this.controllerClientId === clientId) {
      this.leaseExpiresAt = this.now() + CONTROLLER_LEASE_MS;
    }
    return this.statusFor(clientId);
  }

  takeControl(clientId: string): ControllerLeaseStatus {
    this.expireStaleLease();
    this.connectedClients.add(clientId);
    this.grant(clientId);
    return "active";
  }

  statusFor(clientId: string): ControllerLeaseStatus {
    this.expireStaleLease();
    return this.controllerClientId === clientId ? "active" : "secondary";
  }

  canMutate(clientId: string): boolean {
    return this.statusFor(clientId) === "active";
  }

  private expireStaleLease(): void {
    if (this.controllerClientId && this.leaseExpiresAt <= this.now()) {
      this.controllerClientId = null;
      this.leaseExpiresAt = 0;
    }
  }

  private grant(clientId: string): void {
    this.controllerClientId = clientId;
    this.leaseExpiresAt = this.now() + CONTROLLER_LEASE_MS;
  }
}

/** Invoke channels explicitly reviewed as read-only. All other invokes need control. */
export const SAFE_READ_ONLY_INVOKE_CHANNELS = new Set([
  "get-app-version",
  "get-platform",
]);

export function isSafeReadOnlyIpc(message: {
  type: string;
  channel?: string;
}): boolean {
  return (
    message.type === "workspace-directory-entries-request" ||
    (message.type === "ipc-renderer-invoke" &&
      typeof message.channel === "string" &&
      SAFE_READ_ONLY_INVOKE_CHANNELS.has(message.channel))
  );
}
