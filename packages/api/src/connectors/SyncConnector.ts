export interface SyncConnectorRecord {
  externalId: string;
  model: string;
  data: Record<string, unknown>;
  lastModified?: Date;
}

export interface SyncConnectorSession {
  sessionToken: string;
  redirectUrl: string;
}

export interface SyncConnectorConnection {
  connectionId: string;
  provider: string;
  userId: string;
  createdAt: Date;
  lastSyncAt?: Date;
}

export interface SyncConnector {
  readonly name: string;
  isConfigured(): boolean;
  createSession(
    userId: string,
    provider: string,
    workspaceId: string
  ): Promise<SyncConnectorSession>;
  listConnections(userId: string): Promise<SyncConnectorConnection[]>;
  revokeConnection(
    connectionId: string,
    providerConfigKey?: string
  ): Promise<void>;
  fetchRecords(
    connectionId: string,
    model: string,
    since?: Date
  ): Promise<SyncConnectorRecord[]>;
}

/**
 * Registry of sync connectors, keyed by `name`, exposing the public shape
 * (`register`/`get`/`list`) every existing sync caller imports.
 */
export class SyncConnectorRegistry {
  private connectors = new Map<string, SyncConnector>();

  register(c: SyncConnector): void {
    this.connectors.set(c.name, c);
  }

  get(name: string): SyncConnector | undefined {
    return this.connectors.get(name);
  }

  list(): SyncConnector[] {
    return [...this.connectors.values()].filter((c) => c.isConfigured());
  }
}

export const syncConnectorRegistry = new SyncConnectorRegistry();
