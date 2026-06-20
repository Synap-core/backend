/**
 * Unified, type-keyed connector registry + capability detection.
 *
 * Historically the connector layer exposed three DISJOINT registries —
 * `SyncConnectorRegistry` (Nango sync), `EnrichmentProviderRegistry`
 * (apify/apollo) and a hand-written `getMessagingConnector()` if-ladder
 * (unipile/stalwart/discord). All three families now MIRROR into this ONE
 * registry keyed by a `type` string (see `index.ts`), so consumers can look a
 * connector up by `type` OR fan out over a CAPABILITY (`forCapability`) without
 * a `provider === "..."` ladder.
 *
 * Capabilities are DETECTED from the connector's existing method surface
 * (W2 is behavior-preserving — methods are NOT renamed yet; W3/W4 canonicalize
 * `fetchRecords`/`enrich`/`getMessages` → `read` and
 * `sendMessage`/`proxyRequest`/`triggerAction` → `push`). The marker interfaces
 * below describe the CURRENT surfaces; the guards key off the methods that exist
 * today.
 *
 * NOTE: the `mcp://` scheme is NOT modelled here. MCP servers are bridged
 * separately by the `mcp://` scheme handler in `external-dispatch.ts`
 * (owned elsewhere); they are not connector-registry entries.
 */

/** The capability family a connector belongs to. */
export type ConnectorKind = "sync" | "enrichment" | "messaging";

// ── The unified READ contract (W4) ───────────────────────────────────────────
//
// The three pull verbs (`fetchRecords`/`enrich`/`getMessages`) all do the same
// shape of work: take a request describing WHAT to pull, hit an upstream, return
// a list of records. W4 canonicalizes that as ONE `read(req) → ReadResult` whose
// records are normalized to `ReadRecord` so the import sink is connector-agnostic.
//
// The request is discriminated by `kind` (the originating family), so a single
// `read()` adapter on each connector can map its typed method onto the seam
// without losing its own parameters.

/** A request to pull from a `sync` connector (Nango records for one model). */
export interface SyncReadRequest {
  kind: "sync";
  /** Connection id, format `{userId}:{podId}:{provider}`. */
  connectionId: string;
  /** Sync model to pull (e.g. "Contact", "Issue"). */
  model: string;
  /** Only pull records modified after this instant (incremental). */
  since?: Date;
}

/** A request to pull from an `enrichment` connector. */
export interface EnrichmentReadRequest {
  kind: "enrichment";
  /** Enrichment capability the input targets ("person" | "company" | "leads"). */
  capability: string;
  /** Provider-specific lookup input (domain, name, linkedin url, …). */
  input: Record<string, unknown>;
  /** Per-call API key override (enrichment keys are not stored on the instance). */
  apiKey?: string;
}

/** A request to pull a message thread from a `messaging` connector. */
export interface MessagingReadRequest {
  kind: "messaging";
  /** Provider-side account id that owns the thread. */
  accountId: string;
  /** Thread / conversation id to read. */
  threadId: string;
}

export type ReadRequest =
  | SyncReadRequest
  | EnrichmentReadRequest
  | MessagingReadRequest;

/**
 * ONE normalized record every pull produces. `externalId` is the stable
 * upstream key (for idempotent per-record paths); `data` is the flat structured
 * payload the import `connector_sync` adapter turns into an entity-candidate.
 */
export interface ReadRecord {
  /** Stable upstream id for this record (used to build a per-record path). */
  externalId: string;
  /** Logical record type/model (e.g. "Contact", "person", "message"). */
  model: string;
  /** Flat structured payload — one record → one entity-candidate. */
  data: Record<string, unknown>;
  /** Last-modified instant, when the upstream reports one. */
  lastModified?: Date;
}

/** The result of a `read(req)`: the normalized records plus the originating kind. */
export interface ReadResult {
  records: ReadRecord[];
  kind: ConnectorKind;
}

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

// ── Capability MARKER interfaces ─────────────────────────────────────────────
//
// These describe capabilities ACROSS the three families by the method surfaces
// that exist TODAY (no renames this wave). A connector may satisfy several.

/**
 * Has credential lifecycle (configuration check + connection management).
 * Satisfied by Nango (`listConnections`/`revokeConnection`) and the messaging
 * connectors (`getAccounts`/`deleteAccount`).
 */
export interface Credentialed extends BaseConnector {
  isConfigured(...args: unknown[]): boolean;
}

/**
 * Can READ records from the upstream. W4 adds the CANONICAL `read(req)` seam;
 * the three legacy verbs (`fetchRecords` · `enrich` · `getMessages`) remain as
 * thin adapters that `read()` delegates to, so callers dispatch via `read()`
 * (or `readViaConnector()` below) without a per-family branch.
 */
export interface Readable extends BaseConnector {
  /** Canonical pull. Returns normalized `ReadRecord`s for the import sink. */
  read?: (req: ReadRequest) => Promise<ReadResult>;
  // Legacy verbs — present on the concrete connectors, detected by `isReadable`,
  // and adapted by `readViaConnector` when a connector predates `read`.
  fetchRecords?: (...args: unknown[]) => Promise<unknown>;
  enrich?: (...args: unknown[]) => Promise<unknown>;
  getMessages?: (...args: unknown[]) => Promise<unknown>;
}

/**
 * Can PUSH an action upstream. Three names today: `sendMessage` (messaging) ·
 * `proxyRequest`/`triggerAction` (Nango generic HTTP proxy + named action).
 */
export interface Pushable extends BaseConnector {
  // W3/W4: these collapse into a single `push(req)`.
  sendMessage?: (...args: unknown[]) => Promise<unknown>;
  proxyRequest?: (...args: unknown[]) => Promise<unknown>;
  triggerAction?: (...args: unknown[]) => Promise<unknown>;
}

/**
 * Can SENSE inbound events (webhook parsing). Messaging-only today.
 */
export interface Sensing extends BaseConnector {
  parseWebhook?: (...args: unknown[]) => Promise<unknown>;
}

// ── Capability detection GUARDS ──────────────────────────────────────────────
//
// Each keys off the method(s) that implement the capability today. A connector
// is `Readable` if it can do ANY of the three read verbs, etc.

function hasFn(c: unknown, name: string): boolean {
  return typeof (c as Record<string, unknown>)?.[name] === "function";
}

export function isCredentialed(c: BaseConnector): c is Credentialed {
  // Every registered connector has `isConfigured`; "credentialed" specifically
  // means it manages connections/accounts beyond a bare config check.
  return (
    hasFn(c, "listConnections") ||
    hasFn(c, "getAccounts") ||
    hasFn(c, "revokeConnection") ||
    hasFn(c, "deleteAccount")
  );
}

export function isReadable(c: BaseConnector): c is Readable {
  return (
    hasFn(c, "read") ||
    hasFn(c, "fetchRecords") ||
    hasFn(c, "enrich") ||
    hasFn(c, "getMessages")
  );
}

export function isPushable(c: BaseConnector): c is Pushable {
  return (
    hasFn(c, "sendMessage") ||
    hasFn(c, "proxyRequest") ||
    hasFn(c, "triggerAction")
  );
}

export function isSensing(c: BaseConnector): c is Sensing {
  return hasFn(c, "parseWebhook");
}

/**
 * ONE type-keyed registry. Holds every connector regardless of family; callers
 * fetch a specific connector via `get(type)` or fan out over a capability via
 * `forCapability(guard)`.
 */
export class ConnectorRegistry {
  private connectors = new Map<string, BaseConnector>();

  register(c: BaseConnector): void {
    this.connectors.set(c.type, c);
  }

  get(type: string): BaseConnector | undefined {
    return this.connectors.get(type);
  }

  /**
   * Return every registered connector matching a capability guard. Generalizes
   * the old per-family helpers (enrichment's `forCapability`, sync's `list`).
   * Note: does NOT filter on `isConfigured` — messaging descriptors are
   * resolved per-call, so configuration is a resolve-time concern. Callers that
   * need "live only" filter the result.
   */
  forCapability<C extends BaseConnector>(
    guard: (c: BaseConnector) => c is C
  ): C[] {
    return [...this.connectors.values()].filter(guard);
  }
}

/** The process-wide unified connector registry. */
export const connectorRegistry = new ConnectorRegistry();

// ── The ONE read dispatcher ──────────────────────────────────────────────────
//
// Callers (and the import bridge) pull via this single function, never by
// calling a family-specific verb. It prefers the canonical `read(req)` when the
// connector implements it; otherwise it adapts the legacy verb that matches the
// request kind — so a connector that predates `read` still flows through the seam
// and normalizes to `ReadRecord[]`. Throws if the connector can't service the
// requested kind (mismatched connector/request).

/** Coerce an arbitrary upstream row into a normalized `ReadRecord`. */
function toReadRecord(
  raw: unknown,
  fallbackModel: string,
  index: number
): ReadRecord {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const data =
    typeof obj.data === "object" && obj.data !== null
      ? (obj.data as Record<string, unknown>)
      : obj;
  const externalId =
    typeof obj.externalId === "string"
      ? obj.externalId
      : typeof (data as Record<string, unknown>).id === "string"
        ? String((data as Record<string, unknown>).id)
        : `${fallbackModel}-${index}`;
  const model =
    typeof obj.model === "string" && obj.model.length > 0
      ? obj.model
      : fallbackModel;
  const lastModified =
    obj.lastModified instanceof Date ? obj.lastModified : undefined;
  return { externalId, model, data, lastModified };
}

/**
 * Pull from a `Readable` connector through the unified seam.
 *
 * Dispatch order:
 *   1. `read(req)` when the connector implements the canonical seam.
 *   2. else adapt the legacy verb matching `req.kind` and normalize the result.
 */
export async function readViaConnector(
  connector: Readable,
  req: ReadRequest
): Promise<ReadResult> {
  if (typeof connector.read === "function") {
    return connector.read(req);
  }

  if (req.kind === "sync") {
    if (typeof connector.fetchRecords !== "function") {
      throw new Error(
        `Connector "${connector.type}" cannot service a sync read.`
      );
    }
    const records = (await connector.fetchRecords(
      req.connectionId,
      req.model,
      req.since
    )) as unknown[];
    return {
      kind: "sync",
      records: records.map((r, i) => toReadRecord(r, req.model, i)),
    };
  }

  if (req.kind === "enrichment") {
    if (typeof connector.enrich !== "function") {
      throw new Error(
        `Connector "${connector.type}" cannot service an enrichment read.`
      );
    }
    const results = (await connector.enrich(
      req.input,
      req.apiKey
    )) as unknown[];
    return {
      kind: "enrichment",
      records: results.map((r, i) => toReadRecord(r, req.capability, i)),
    };
  }

  // messaging
  if (typeof connector.getMessages !== "function") {
    throw new Error(
      `Connector "${connector.type}" cannot service a messaging read.`
    );
  }
  const messages = (await connector.getMessages(
    req.accountId,
    req.threadId
  )) as unknown[];
  return {
    kind: "messaging",
    records: messages.map((m, i) => toReadRecord(m, "message", i)),
  };
}
