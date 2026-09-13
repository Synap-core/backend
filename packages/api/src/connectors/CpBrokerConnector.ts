import type {
  SyncConnectorConnection,
  SyncConnectorSession,
} from "./SyncConnector.js";
import type {
  NangoConnectionsResult,
  NangoIntegrationsResult,
} from "./NangoConnector.js";
import type {
  BrokerConnectionResult,
  BrokerProbeResult,
  BrokerProxyParams,
  BrokerProxyResult,
  ConnectionBroker,
} from "./ConnectionBroker.js";

/**
 * The broker refused the request for a reason the user can act on (tier limit,
 * undeclared provider). Carries the CP's machine code so a door can map it to a
 * FORBIDDEN / precondition rather than a generic 500.
 */
export class BrokerRefusalError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number
  ) {
    super(message);
    this.name = "BrokerRefusalError";
  }
}

/**
 * The broker has no such connection for this user. Thrown by `revokeConnection`
 * so a revoke that did not happen can never read as one that did; a caller that
 * has ALREADY proven ownership may treat it as "already gone".
 */
export class BrokerConnectionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerConnectionNotFoundError";
  }
}

type FailureReason =
  "unreachable" | "unauthenticated" | "malformed" | "truncated";
const FAILURE_REASONS = new Set<FailureReason>([
  "unreachable",
  "unauthenticated",
  "malformed",
  "truncated",
]);

type Sent =
  | { ok: true; status: number; json: Record<string, unknown> | null }
  | { ok: false; error: string };

interface BrokerConnectionRow {
  connectionId: string;
  provider: string;
  createdAt: string | null;
  lastFetchedAt: string | null;
  hasError: boolean;
  objectScoped: boolean;
}

/**
 * The CP-managed pod's broker client. The pod holds no Nango key: every call
 * goes to the Control Plane's `/api/connector-broker`, authenticated with the
 * pod's CP-issued relay JWT. The CP derives the pod's identity from that token
 * and filters Nango to the pod's `<podId>:<podUserId>` namespace, so this client
 * only ever names the pod USER — never the pod.
 */
export class CpBrokerConnector implements ConnectionBroker {
  readonly mode = "cp" as const;

  constructor(private readonly opts: { cpUrl: string; relayKey: string }) {}

  getConnectUrl(): string | null {
    return null;
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<Sent> {
    let res: Response;
    try {
      res = await fetch(
        `${this.opts.cpUrl.replace(/\/+$/, "")}/api/connector-broker${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.opts.relayKey}`,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        }
      );
    } catch (err) {
      return {
        ok: false,
        error: `Cannot reach the control plane broker: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const json = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    return { ok: true, status: res.status, json };
  }

  /** Map a non-200 broker answer onto the typed failure the pod already speaks. */
  private failure(sent: Sent): { reason: FailureReason; error: string } {
    if (!sent.ok) return { reason: "unreachable", error: sent.error };
    const error =
      typeof sent.json?.error === "string"
        ? sent.json.error
        : `Control plane broker returned ${sent.status}`;
    if (sent.status === 401 || sent.status === 403) {
      return {
        reason: "unauthenticated",
        error: `The control plane rejected this pod's broker credential: ${error}`,
      };
    }
    const reason = sent.json?.reason;
    return {
      reason:
        typeof reason === "string" &&
        FAILURE_REASONS.has(reason as FailureReason)
          ? (reason as FailureReason)
          : "unreachable",
      error,
    };
  }

  private async fetchRows(
    userId: string
  ): Promise<
    | { ok: true; rows: BrokerConnectionRow[] }
    | { ok: false; reason: FailureReason; error: string }
  > {
    const sent = await this.send(
      "GET",
      `/connections?${new URLSearchParams({ podUserId: userId })}`
    );
    if (!sent.ok || sent.status !== 200) {
      return { ok: false, ...this.failure(sent) };
    }
    const rows = sent.json?.connections;
    if (!Array.isArray(rows)) {
      return {
        ok: false,
        reason: "malformed",
        error: "Control plane broker returned no connections array",
      };
    }
    return { ok: true, rows: rows as BrokerConnectionRow[] };
  }

  async listConnectionsResult(userId: string): Promise<NangoConnectionsResult> {
    const r = await this.fetchRows(userId);
    if (!r.ok) return r;
    const connections: SyncConnectorConnection[] = r.rows.map((c) => ({
      connectionId: c.connectionId,
      provider: c.provider,
      userId,
      createdAt: c.createdAt ? new Date(c.createdAt) : new Date(),
      lastSyncAt: c.lastFetchedAt ? new Date(c.lastFetchedAt) : undefined,
      hasError: c.hasError === true,
    }));
    return { ok: true, connections };
  }

  async getConnectionResult(
    userId: string,
    providerConfigKey: string,
    connectionId: string
  ): Promise<BrokerConnectionResult> {
    const sent = await this.send(
      "GET",
      `/connections/${encodeURIComponent(connectionId)}?${new URLSearchParams({
        podUserId: userId,
        providerConfigKey,
      })}`
    );
    // 404 = not this user's connection (absent or another namespace — the CP
    // gives one answer for both).
    if (sent.ok && sent.status === 404) return { ok: true, connection: null };
    if (!sent.ok || sent.status !== 200) {
      const f = this.failure(sent);
      // A by-id read is never paged, so `truncated` cannot describe it.
      return {
        ok: false,
        reason: f.reason === "truncated" ? "malformed" : f.reason,
        error: f.error,
      };
    }
    const c = sent.json?.connection as BrokerConnectionRow | undefined;
    if (
      !c ||
      typeof c.connectionId !== "string" ||
      typeof c.provider !== "string"
    ) {
      return {
        ok: false,
        reason: "malformed",
        error: "Control plane broker returned no connection",
      };
    }
    return {
      ok: true,
      connection: {
        connectionId: c.connectionId,
        provider: c.provider,
        userId,
        createdAt: c.createdAt ? new Date(c.createdAt) : new Date(),
        lastSyncAt: c.lastFetchedAt ? new Date(c.lastFetchedAt) : undefined,
        hasError: c.hasError === true,
      },
    };
  }

  async listIntegrationsResult(): Promise<NangoIntegrationsResult> {
    const sent = await this.send("GET", "/integrations");
    if (!sent.ok || sent.status !== 200) {
      const f = this.failure(sent);
      // The integration list is never paged, so `truncated` cannot describe it.
      return {
        ok: false,
        reason: f.reason === "truncated" ? "malformed" : f.reason,
        error: f.error,
      };
    }
    const items = sent.json?.integrations;
    if (!Array.isArray(items)) {
      return {
        ok: false,
        reason: "malformed",
        error: "Control plane broker returned no integrations array",
      };
    }
    return {
      ok: true,
      integrations: (
        items as Array<{
          uniqueKey: string;
          provider: string;
          displayName?: string;
        }>
      ).map((i) => ({
        uniqueKey: i.uniqueKey,
        provider: i.provider,
        displayName: i.displayName ?? i.provider,
      })),
    };
  }

  async createSession(
    userId: string,
    provider: string,
    _workspaceId: string
  ): Promise<SyncConnectorSession> {
    const sent = await this.send("POST", "/session", {
      podUserId: userId,
      ...(provider && provider !== "*" ? { providerId: provider } : {}),
    });
    if (!sent.ok) throw new Error(sent.error);
    if (sent.status !== 200) {
      const { error } = this.failure(sent);
      const code = sent.json?.code;
      if (typeof code === "string") {
        throw new BrokerRefusalError(error, code, sent.status);
      }
      throw new Error(error);
    }
    const token = sent.json?.token;
    const connectLink = sent.json?.connectLink;
    if (typeof token !== "string" || typeof connectLink !== "string") {
      throw new Error("Control plane broker returned no connect link");
    }
    return { sessionToken: token, redirectUrl: connectLink };
  }

  async revokeConnection(
    connectionId: string,
    providerConfigKey: string | undefined,
    userId: string
  ): Promise<void> {
    if (!userId) {
      throw new Error("A broker revoke must name the acting user");
    }
    const sent = await this.send("POST", "/revoke", {
      podUserId: userId,
      connectionId,
      // With the key the CP proves ownership of this one connection by id.
      ...(providerConfigKey ? { providerConfigKey } : {}),
    });
    if (!sent.ok) throw new Error(sent.error);
    if (sent.status === 200) return;
    // 404 = not in THIS user's namespace. Nothing was revoked: never report it
    // as done (an admin revoking a member's connection used to "succeed" here).
    if (sent.status === 404) {
      throw new BrokerConnectionNotFoundError(
        `Connection ${connectionId} is not among this user's connections — nothing was revoked`
      );
    }
    throw new Error(this.failure(sent).error);
  }

  async proxyRequest(params: BrokerProxyParams): Promise<BrokerProxyResult> {
    if (!params.userId) {
      throw new Error("A broker proxy call must name the acting user");
    }
    const sent = await this.send("POST", "/proxy", {
      podUserId: params.userId,
      connectionId: params.connectionId,
      providerConfigKey: params.providerConfigKey,
      method: params.method.toUpperCase(),
      path: params.path,
      body: params.body,
      baseUrlOverride: params.baseUrlOverride,
      headers: params.headers,
    });
    if (!sent.ok) throw new Error(sent.error);
    if (sent.status === 200 && sent.json?.proxied === true) {
      return {
        status: Number(sent.json.status),
        headers: (sent.json.headers as Record<string, string>) ?? {},
        body: sent.json.body,
      };
    }
    // The broker refused the call itself (bad path, not your connection) —
    // surface it as the status the dispatcher already knows how to report.
    if (sent.status === 400 || sent.status === 404) {
      return {
        status: sent.status,
        headers: {},
        body: { error: { message: this.failure(sent).error } },
      };
    }
    throw new Error(this.failure(sent).error);
  }

  async probe(): Promise<BrokerProbeResult> {
    const sent = await this.send("GET", "/probe");
    if (!sent.ok) {
      return { reachable: false, authenticated: false, error: sent.error };
    }
    if (sent.status !== 200) {
      return {
        reachable: true,
        authenticated: false,
        error: this.failure(sent).error,
      };
    }
    return {
      reachable: sent.json?.reachable === true,
      authenticated: sent.json?.authenticated === true,
      error: typeof sent.json?.error === "string" ? sent.json.error : null,
    };
  }

  async dedupeConnections(userId: string, provider: string): Promise<string[]> {
    const r = await this.fetchRows(userId);
    if (!r.ok) {
      throw new Error(`Could not list connections to dedupe: ${r.error}`);
    }
    const plain = r.rows
      .filter((c) => c.provider === provider && !c.objectScoped)
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    const revoked: string[] = [];
    for (const c of plain.slice(1)) {
      await this.revokeConnection(c.connectionId, provider, userId);
      revoked.push(c.connectionId);
    }
    return revoked;
  }
}
