import type {
  SyncConnectorConnection,
  SyncConnectorSession,
} from "./SyncConnector.js";
import type {
  NangoConnectionsResult,
  NangoIntegrationsResult,
} from "./NangoConnector.js";

/**
 * The connection broker seam behind the `nango://` scheme.
 *
 * Two implementations, one shape:
 *   - `CpBrokerConnector` (mode "cp")  — a Control-Plane-managed pod. The pod
 *     holds NO Nango key; the CP brokers every call in the pod's namespace.
 *   - `NangoConnector`    (mode "local") — a self-hosted pod with its own Nango
 *     key in the vault.
 *
 * Every caller resolves one through `resolveBroker()` and never branches on the
 * mode. `nango://<providerConfigKey>` refs are unchanged by which one answers.
 */
export type BrokerMode = "cp" | "local";

export interface BrokerProxyParams {
  /** The acting pod user — the CP broker proves the connection is theirs. */
  userId: string;
  connectionId: string;
  providerConfigKey: string;
  method: string;
  path: string;
  body?: unknown;
  /** Per-call proxy base URL (Nango `Base-Url-Override`). */
  baseUrlOverride?: string;
  /** Static custom request headers; auth + routing headers always win. */
  headers?: Record<string, string>;
}

export interface BrokerProxyResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface BrokerProbeResult {
  reachable: boolean;
  authenticated: boolean;
  error: string | null;
}

/**
 * One of the user's connections, read by id. `connection: null` = the broker
 * answered and the user has no such connection (absent, another user's, or
 * another provider's — one answer); a failed lookup is `ok:false`.
 */
export type BrokerConnectionResult =
  | { ok: true; connection: SyncConnectorConnection | null }
  | {
      ok: false;
      reason: "unreachable" | "unauthenticated" | "malformed";
      error: string;
    };

export interface ConnectionBroker {
  readonly mode: BrokerMode;
  /** The user's live connections — a failed read is `ok:false`, never `[]`. */
  listConnectionsResult(userId: string): Promise<NangoConnectionsResult>;
  /**
   * One connection by id, without listing the user's (or the environment's)
   * connections — for a caller that already knows which connection it wants.
   */
  getConnectionResult(
    userId: string,
    providerConfigKey: string,
    connectionId: string
  ): Promise<BrokerConnectionResult>;
  listIntegrationsResult(): Promise<NangoIntegrationsResult>;
  createSession(
    userId: string,
    provider: string,
    workspaceId: string
  ): Promise<SyncConnectorSession>;
  /** Throws when the revoke did not happen; an already-gone connection is success. */
  revokeConnection(
    connectionId: string,
    providerConfigKey: string | undefined,
    userId: string
  ): Promise<void>;
  /** A provider 4xx/5xx comes back as a status; a broker fault throws. */
  proxyRequest(params: BrokerProxyParams): Promise<BrokerProxyResult>;
  probe(): Promise<BrokerProbeResult>;
  /** Keep the newest un-scoped (user, provider) connection; revoke older dups. */
  dedupeConnections(userId: string, provider: string): Promise<string[]>;
  /** Public Connect URL for browser use, when the broker exposes one. */
  getConnectUrl(): string | null;
}
