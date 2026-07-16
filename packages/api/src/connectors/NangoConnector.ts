import { z } from "zod";
import type {
  SyncConnector,
  SyncConnectorConnection,
  SyncConnectorRecord,
  SyncConnectorSession,
} from "./SyncConnector.js";
import type { ReadRequest, ReadResult } from "./ConnectorRegistry.js";

const NangoRecordSchema = z
  .object({
    _nango_metadata: z.object({
      first_seen_at: z.string(),
      last_modified_at: z.string(),
      last_action: z.enum(["ADDED", "UPDATED", "DELETED"]),
      deleted_at: z.string().nullable(),
    }),
  })
  .catchall(z.unknown());

const NangoRecordsResponseSchema = z.object({
  records: z.array(NangoRecordSchema),
  next_cursor: z.string().nullable().optional(),
});

const NangoConnectionSchema = z.object({
  connection_id: z.string(),
  provider_config_key: z.string(),
  // `created_at` is absent on some self-hosted list shapes — keep it optional so
  // a present-but-unfiltered connection still parses.
  created_at: z.string().optional(),
  last_fetched_at: z.string().optional(),
  // The Connect end-user the connection belongs to. We filter on this
  // CLIENT-SIDE (see listConnections) because Nango's `?end_user_id=` query
  // filter is broken on the self-hosted version — it returns 0 even when a
  // connection with that exact end_user exists.
  end_user: z
    .object({
      id: z.string().nullable().optional(),
      // Object-scope: a connection bound to a specific pod object (entity/project)
      // carries it here. Such connections are NEVER deduped — a user can hold
      // several accounts of the same provider for different entities/projects.
      tags: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .nullable()
    .optional(),
});

const NangoConnectionsResponseSchema = z.object({
  connections: z.array(NangoConnectionSchema),
});

const NangoSessionResponseSchema = z.union([
  z.object({ token: z.string(), connect_link: z.string().optional() }),
  z.object({
    data: z.object({ token: z.string(), connect_link: z.string().optional() }),
  }),
]);

const NangoIntegrationSchema = z.object({
  unique_key: z.string(),
  provider: z.string(),
  display_name: z.string().optional(),
});

const NangoIntegrationsResponseSchema = z.union([
  z.object({ configs: z.array(NangoIntegrationSchema) }),
  z.object({ data: z.array(NangoIntegrationSchema) }),
]);

/** One declared Nango integration, normalized to Synap's naming. */
export interface NangoIntegration {
  uniqueKey: string;
  provider: string;
  displayName: string;
}

/**
 * The TYPED outcome of listing this environment's declared integrations.
 *
 * `ok:true` with `integrations: []` means Nango answered and genuinely declares
 * ZERO integrations. `ok:false` means we could not find out — which is a
 * DIFFERENT fact and must never be presented as "no integrations". Callers that
 * need to tell a real emptiness from a failed lookup use this; the legacy
 * `listIntegrations()` wrapper flattens both to `[]` for callers that don't.
 */
export type NangoIntegrationsResult =
  | { ok: true; integrations: NangoIntegration[] }
  | {
      ok: false;
      reason: "unreachable" | "unauthenticated" | "malformed";
      error: string;
    };

export class NangoConnector implements SyncConnector {
  readonly name = "nango";

  constructor(
    private readonly overrides?: {
      host?: string;
      secretKey?: string;
      /** Public-facing URL for browser redirects (may differ from internal API host). */
      connectUrl?: string;
    }
  ) {}

  private get host(): string {
    return (
      this.overrides?.host || process.env.NANGO_HOST || "http://localhost:3003"
    );
  }

  /** Public URL used in browser redirects — defaults to host when not set. */
  private get connectUrl(): string {
    return (
      this.overrides?.connectUrl || process.env.NANGO_CONNECT_URL || this.host
    );
  }

  private get secretKey(): string | undefined {
    return this.overrides?.secretKey || process.env.NANGO_SECRET_KEY;
  }

  isConfigured(): boolean {
    return !!this.secretKey;
  }

  /** Public-facing URL for browser use (may differ from internal API host). */
  getConnectUrl(): string {
    return this.connectUrl;
  }

  getHost(): string {
    return this.host;
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.secretKey}`,
      "Content-Type": "application/json",
    };
  }

  /** Build connection ID in the format used across Synap: "{userId}:{podId}:{provider}" */
  static buildConnectionId(userId: string, provider: string): string {
    const podId = process.env.POD_ID ?? "local";
    return `${userId}:${podId}:${provider}`;
  }

  async createSession(
    userId: string,
    provider: string,
    _workspaceId: string
  ): Promise<SyncConnectorSession> {
    const res = await fetch(`${this.host}/connect/sessions`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        end_user: { id: userId, display_name: userId },
        // Pre-select the provider so Nango's Connect UI skips its integration
        // picker and goes straight to the provider's OAuth consent screen.
        // `*` means "no specific provider" → show all available integrations.
        // Nango validates these against the environment's configured integrations
        // (so the secret key MUST match the environment that owns them).
        ...(provider && provider !== "*"
          ? { allowed_integrations: [provider] }
          : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Nango createSession failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ""}`
      );
    }

    const rawText = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      // Nango returned HTML — usually means the Connect UI endpoint doesn't
      // exist on this self-hosted version. Requires Nango v0.40.0+.
      throw new Error(
        `Nango createSession: server returned HTML instead of JSON — ` +
          `ensure self-hosted Nango is v0.40.0+ with the Connect UI enabled. ` +
          `Response preview: ${rawText.slice(0, 200)}`
      );
    }
    const parsed = NangoSessionResponseSchema.safeParse(json);
    if (!parsed.success)
      throw new Error("Nango createSession: unexpected response shape");

    const inner = "data" in parsed.data ? parsed.data.data : parsed.data;
    const token = inner.token;
    // Use Nango's own connect_link when available (self-hosted v0.70+ returns
    // the full Connect UI URL). Falls back to constructing it from configured
    // connectUrl + token for older versions.
    const base = inner.connect_link ?? `${this.connectUrl}?token=${token}`;
    // KNOWN NANGO SELF-HOST BUG (#5432): the standalone Connect UI defaults its
    // apiURL to https://api.nango.dev (Nango Cloud) instead of our self-hosted
    // server — so it validates the session token against Cloud and shows
    // "session expired". The standalone UI reads an `apiURL` query param, so we
    // append our API host to point it at the right backend.
    const connectLink = new URL(base);
    connectLink.searchParams.set("apiURL", this.host);
    return {
      sessionToken: token,
      redirectUrl: connectLink.toString(),
    };
  }

  async listConnections(userId: string): Promise<SyncConnectorConnection[]> {
    // Fetch the env's connections and filter by end_user CLIENT-SIDE. We do NOT
    // pass `?end_user_id=` because that filter is BROKEN on the self-hosted Nango
    // (it returns 0 even when a connection with that exact end_user exists). The
    // unfiltered list carries `end_user.id`, so we match on it ourselves. Scope is
    // the env (the secret key's environment) — i.e. this pod's own connections.
    const res = await fetch(`${this.host}/connection`, {
      headers: this.authHeaders(),
    });

    if (!res.ok) return [];

    const parsed = NangoConnectionsResponseSchema.safeParse(await res.json());
    if (!parsed.success) return [];

    return parsed.data.connections
      .filter((c) => c.end_user?.id === userId)
      .map((c) => ({
        connectionId: c.connection_id,
        provider: c.provider_config_key,
        userId,
        createdAt: c.created_at ? new Date(c.created_at) : new Date(),
        lastSyncAt: c.last_fetched_at ? new Date(c.last_fetched_at) : undefined,
      }));
  }

  async revokeConnection(connectionId: string): Promise<void> {
    await fetch(`${this.host}/connection/${connectionId}`, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
  }

  /**
   * Idempotency for `(user, provider)`: keep ONE connection, revoke stale dups.
   *
   * Reconnecting a provider creates a brand-new Nango connection without clearing
   * the old one (we saw a user accumulate two `google` connections). This keeps
   * the MOST RECENT un-scoped connection and revokes the older un-scoped ones —
   * EXCEPT connections bound to a specific pod object (an `end_user.tags.entityId`
   * or `.projectId`), which are deliberately preserved (a user may hold several
   * accounts of the same provider, one per entity/project).
   *
   * Returns the connectionIds it revoked.
   */
  async dedupeConnections(userId: string, provider: string): Promise<string[]> {
    const res = await fetch(`${this.host}/connection`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) return [];
    const parsed = NangoConnectionsResponseSchema.safeParse(await res.json());
    if (!parsed.success) return [];

    const isObjectScoped = (c: { end_user?: { tags?: unknown } | null }) => {
      const t = c.end_user?.tags;
      return (
        !!t &&
        typeof t === "object" &&
        ((t as Record<string, unknown>).entityId != null ||
          (t as Record<string, unknown>).projectId != null)
      );
    };

    // This user's connections for this provider that are NOT object-scoped.
    const plain = parsed.data.connections
      .filter(
        (c) =>
          c.end_user?.id === userId &&
          c.provider_config_key === provider &&
          !isObjectScoped(c)
      )
      // Most recent first (created_at may be absent → treat as oldest).
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));

    // Keep [0] (newest); revoke the rest.
    const revoked: string[] = [];
    for (const c of plain.slice(1)) {
      try {
        await this.revokeConnection(c.connection_id);
        revoked.push(c.connection_id);
      } catch {
        // Best-effort — a failed revoke must not break the connect flow.
      }
    }
    return revoked;
  }

  /**
   * List this environment's declared integrations, PRESERVING WHY a lookup came
   * back without any. Never throws — every failure is a typed `ok:false` — so
   * adding a caller can't turn a soft empty list into a hard 500.
   *
   * Failure mapping: 401/403 → `unauthenticated` (the secret key doesn't belong
   * to this Nango environment); a network/timeout error, or any other non-OK
   * status (Nango answered but not usefully), → `unreachable`; a response we
   * can't parse → `malformed`.
   */
  async listIntegrationsResult(): Promise<NangoIntegrationsResult> {
    let res: Response;
    try {
      res = await fetch(`${this.host}/integrations`, {
        headers: this.authHeaders(),
      });
    } catch (err) {
      return {
        ok: false,
        reason: "unreachable",
        error: `Cannot reach ${this.host}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        reason: "unauthenticated",
        error: `Nango rejected the secret key (${res.status})`,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: "unreachable",
        error: `Nango returned ${res.status}`,
      };
    }

    const parsed = NangoIntegrationsResponseSchema.safeParse(
      await res.json().catch(() => null)
    );
    if (!parsed.success) {
      return {
        ok: false,
        reason: "malformed",
        error: "Nango returned an integration list we could not parse",
      };
    }

    const items =
      "data" in parsed.data ? parsed.data.data : parsed.data.configs;
    return {
      ok: true,
      integrations: items.map((c) => ({
        uniqueKey: c.unique_key,
        provider: c.provider,
        displayName: c.display_name ?? c.provider,
      })),
    };
  }

  /**
   * Legacy list: flattens every failure to `[]`.
   *
   * KEPT for callers that only need a best-effort list and are NOT wrapped in a
   * try/catch. It CANNOT distinguish "Nango unreachable" / "wrong secret key" /
   * "genuinely zero integrations" — when that difference matters (i.e. when you
   * are about to tell a human why their connect failed), call
   * `listIntegrationsResult()` instead.
   */
  async listIntegrations(): Promise<NangoIntegration[]> {
    const r = await this.listIntegrationsResult();
    return r.ok ? r.integrations : [];
  }

  /**
   * Proxy a generic request through Nango's proxy endpoint.
   *
   * Forwards the given HTTP method + path through Nango, setting the
   * Connection-Id and Provider-Config-Key headers so Nango resolves the
   * credential and forwards the request to the underlying provider API.
   *
   * Returns the raw response status, headers, and parsed body.
   */
  async proxyRequest(params: {
    connectionId: string;
    providerConfigKey: string;
    method: string;
    path: string;
    body?: unknown;
    /**
     * Override the provider's default proxy base URL for THIS call. Needed when
     * one connection spans multiple API hosts — e.g. a single `google` OAuth
     * connection reaches Calendar/Drive on www.googleapis.com (the provider
     * default) but Gmail on gmail.googleapis.com. Maps to Nango's
     * `Base-Url-Override` proxy header.
     */
    baseUrlOverride?: string;
    /**
     * Optional static custom request headers (e.g. Cal.com's `cal-api-version`).
     * SECURITY: spread FIRST below so Nango's auth + structural headers
     * (Connection-Id / Provider-Config-Key / Base-Url-Override) always WIN — a
     * custom header can never override auth or smuggle a different connection.
     */
    headers?: Record<string, string>;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: unknown;
  }> {
    const res = await fetch(`${this.host}/proxy${params.path}`, {
      method: params.method.toUpperCase(),
      headers: {
        ...(params.headers ?? {}),
        ...this.authHeaders(),
        "Connection-Id": params.connectionId,
        "Provider-Config-Key": params.providerConfigKey,
        ...(params.baseUrlOverride
          ? { "Base-Url-Override": params.baseUrlOverride }
          : {}),
      },
      body: params.body ? JSON.stringify(params.body) : undefined,
    });

    const raw = await res.text();
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Keep as text if not JSON
    }

    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });

    return { status: res.status, headers, body: parsed };
  }

  async probe(): Promise<{
    reachable: boolean;
    authenticated: boolean;
    error: string | null;
  }> {
    try {
      const res = await fetch(`${this.host}/integrations`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401 || res.status === 403) {
        return {
          reachable: true,
          authenticated: false,
          error: `Invalid secret key (${res.status})`,
        };
      }
      if (!res.ok) {
        return {
          reachable: true,
          authenticated: false,
          error: `Nango returned ${res.status}`,
        };
      }
      return { reachable: true, authenticated: true, error: null };
    } catch (err) {
      return {
        reachable: false,
        authenticated: false,
        error: `Cannot reach ${this.host}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Trigger a Nango action (external write) on a connected integration.
   * Posts to Nango's REST `/action/trigger` with the connection headers used
   * elsewhere in this connector. Returns the raw action response.
   */
  async triggerAction(params: {
    connectionId: string;
    providerConfigKey: string;
    actionName: string;
    input: Record<string, unknown>;
  }): Promise<unknown> {
    const res = await fetch(`${this.host}/action/trigger`, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Connection-Id": params.connectionId,
        "Provider-Config-Key": params.providerConfigKey,
      },
      body: JSON.stringify({
        action_name: params.actionName,
        input: params.input,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Nango triggerAction failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ""}`
      );
    }

    return res.json();
  }

  /**
   * Canonical W4 read seam. Maps a `sync` read request onto `fetchRecords` and
   * normalizes each Nango record to a `ReadRecord` for the unified import sink.
   * Mismatched request kinds throw (a Nango connector only services sync reads).
   */
  async read(req: ReadRequest): Promise<ReadResult> {
    if (req.kind !== "sync") {
      throw new Error(
        `NangoConnector.read: unsupported read kind "${req.kind}"`
      );
    }
    const records = await this.fetchRecords(
      req.connectionId,
      req.model,
      req.since
    );
    return {
      kind: "sync",
      records: records.map((r) => ({
        externalId: r.externalId,
        model: r.model,
        data: r.data,
        lastModified: r.lastModified,
      })),
    };
  }

  async fetchRecords(
    connectionId: string,
    model: string,
    since?: Date
  ): Promise<SyncConnectorRecord[]> {
    const params = new URLSearchParams({ model, connection_id: connectionId });
    if (since) params.set("modified_after", since.toISOString());

    const res = await fetch(`${this.host}/records?${params}`, {
      headers: this.authHeaders(),
    });

    if (!res.ok) return [];

    const parsed = NangoRecordsResponseSchema.safeParse(await res.json());
    if (!parsed.success) return [];

    return parsed.data.records
      .filter((r) => r._nango_metadata.last_action !== "DELETED")
      .map((r) => {
        const { _nango_metadata, ...data } = r;
        return {
          externalId: String(
            (data as Record<string, unknown>).id ?? connectionId
          ),
          model,
          data: data as Record<string, unknown>,
          lastModified: new Date(_nango_metadata.last_modified_at),
        };
      });
  }
}
