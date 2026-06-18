import { z } from "zod";
import type {
  SyncConnector,
  SyncConnectorConnection,
  SyncConnectorRecord,
  SyncConnectorSession,
} from "./SyncConnector.js";

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
  created_at: z.string(),
  last_fetched_at: z.string().optional(),
});

const NangoConnectionsResponseSchema = z.object({
  connections: z.array(NangoConnectionSchema),
});

const NangoSessionResponseSchema = z.union([
  z.object({ token: z.string() }),
  z.object({ data: z.object({ token: z.string() }) }),
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
        // Omit allowed_integrations to show all configured integrations
        ...(provider !== "*" ? { allowed_integrations: [provider] } : {}),
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

    const token =
      "data" in parsed.data ? parsed.data.data.token : parsed.data.token;
    return {
      sessionToken: token,
      redirectUrl: `${this.connectUrl}?token=${token}`,
    };
  }

  async listConnections(userId: string): Promise<SyncConnectorConnection[]> {
    const res = await fetch(`${this.host}/connection?end_user_id=${userId}`, {
      headers: this.authHeaders(),
    });

    if (!res.ok) return [];

    const parsed = NangoConnectionsResponseSchema.safeParse(await res.json());
    if (!parsed.success) return [];

    return parsed.data.connections.map((c) => ({
      connectionId: c.connection_id,
      provider: c.provider_config_key,
      userId,
      createdAt: new Date(c.created_at),
      lastSyncAt: c.last_fetched_at ? new Date(c.last_fetched_at) : undefined,
    }));
  }

  async revokeConnection(connectionId: string): Promise<void> {
    await fetch(`${this.host}/connection/${connectionId}`, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
  }

  async listIntegrations(): Promise<
    Array<{ uniqueKey: string; provider: string; displayName: string }>
  > {
    const res = await fetch(`${this.host}/integrations`, {
      headers: this.authHeaders(),
    });

    if (!res.ok) return [];

    const parsed = NangoIntegrationsResponseSchema.safeParse(
      await res.json().catch(() => null)
    );
    if (!parsed.success) return [];

    const items =
      "data" in parsed.data ? parsed.data.data : parsed.data.configs;
    return items.map((c) => ({
      uniqueKey: c.unique_key,
      provider: c.provider,
      displayName: c.display_name ?? c.provider,
    }));
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
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: unknown;
  }> {
    const res = await fetch(`${this.host}/proxy${params.path}`, {
      method: params.method.toUpperCase(),
      headers: {
        ...this.authHeaders(),
        "Connection-Id": params.connectionId,
        "Provider-Config-Key": params.providerConfigKey,
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
