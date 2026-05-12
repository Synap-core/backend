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

const NangoSessionResponseSchema = z.object({
  token: z.string(),
});

const NangoIntegrationSchema = z.object({
  unique_key: z.string(),
  provider: z.string(),
  display_name: z.string().optional(),
});

const NangoIntegrationsResponseSchema = z.object({
  configs: z.array(NangoIntegrationSchema),
});

export class NangoConnector implements SyncConnector {
  readonly name = "nango";

  private get host(): string {
    return process.env.NANGO_HOST ?? "http://localhost:3003";
  }

  private get secretKey(): string | undefined {
    return process.env.NANGO_SECRET_KEY;
  }

  isConfigured(): boolean {
    return !!this.secretKey;
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
    workspaceId: string
  ): Promise<SyncConnectorSession> {
    const res = await fetch(`${this.host}/connect/sessions`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        end_user: { id: userId, display_name: userId },
        allowed_integrations: [provider],
        metadata: { workspaceId },
      }),
    });

    if (!res.ok) {
      throw new Error(
        `Nango createSession failed: ${res.status} ${res.statusText}`
      );
    }

    const parsed = NangoSessionResponseSchema.safeParse(await res.json());
    if (!parsed.success)
      throw new Error("Nango createSession: unexpected response shape");

    return {
      sessionToken: parsed.data.token,
      redirectUrl: `${this.host}/connect?token=${parsed.data.token}`,
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
    const res = await fetch(`${this.host}/config`, {
      headers: this.authHeaders(),
    });

    if (!res.ok) return [];

    const parsed = NangoIntegrationsResponseSchema.safeParse(await res.json());
    if (!parsed.success) return [];

    return parsed.data.configs.map((c) => ({
      uniqueKey: c.unique_key,
      provider: c.provider,
      displayName: c.display_name ?? c.provider,
    }));
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
