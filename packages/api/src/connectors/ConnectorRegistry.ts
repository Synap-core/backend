/**
 * Unified, type-keyed connector registry.
 *
 * Historically the connector layer exposed three DISJOINT registries —
 * `SyncConnectorRegistry` (Nango sync), `EnrichmentProviderRegistry`
 * (apify/apollo) and a hand-written `getMessagingConnector()` if-ladder
 * (unipile/stalwart/discord). This collapses the messaging lookup onto ONE
 * registry keyed by a `type` string, with a common base interface every
 * registered connector implements.
 *
 * The registry is agnostic: connectors register themselves under a `type`
 * key and declare a `kind` so consumers can look them up by capability
 * (sync / enrichment / messaging) without a `provider === "..."` ladder.
 *
 * NOTE: the `mcp://` scheme is NOT modelled here. MCP servers are bridged
 * separately by the `mcp://` scheme handler in `external-dispatch.ts`
 * (owned elsewhere); they are not connector-registry entries.
 */

/** The capability family a connector belongs to. */
export type ConnectorKind = "sync" | "enrichment" | "messaging";

/**
 * Common base every registered connector satisfies. `type` is the registry
 * key (e.g. "nango", "apify", "unipile"); `kind` is its capability family.
 * `isConfigured` lets the registry filter to live connectors.
 */
export interface BaseConnector {
  /** Registry key. Unique per registered connector. */
  readonly type: string;
  /** Capability family used for kind-scoped lookups. */
  readonly kind: ConnectorKind;
  isConfigured(...args: unknown[]): boolean;
}

/**
 * ONE type-keyed registry. Holds every connector regardless of kind; callers
 * fetch a specific connector via `get()`.
 */
export class ConnectorRegistry {
  private connectors = new Map<string, BaseConnector>();

  register(c: BaseConnector): void {
    this.connectors.set(c.type, c);
  }

  get(type: string): BaseConnector | undefined {
    return this.connectors.get(type);
  }
}

/** The process-wide unified connector registry. */
export const connectorRegistry = new ConnectorRegistry();
