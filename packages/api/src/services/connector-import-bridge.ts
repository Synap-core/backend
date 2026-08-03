/**
 * Connector → Import bridge (W4: the ONE governed pull→import sink).
 *
 * THE GAP this closes: a pull from an upstream (Nango records, an enrichment
 * lookup, a messaging thread) previously had THREE disjoint fates — Nango synced
 * to a governed `import.graph` proposal, enrichment returned to the caller, and
 * messaging-read went only to a live inbox cache. W4 unifies the "import these
 * into my pod" path: ANY `Readable` connector resolved from `connectorRegistry`
 * is pulled via the canonical `read(req)` seam, and its normalized `ReadRecord`s
 * are routed through `ImportOrchestrator.analyze()` so each pull lands as ONE
 * reviewable proposal (never a direct write).
 *
 * The bridge no longer imports a concrete connector — it resolves any connector
 * by registry `type` (or accepts a DI instance) and dispatches through
 * `readViaConnector`, so the sink is connector-agnostic.
 *
 * NAMED DEFAULT: on-demand only ("pull this now → proposal"). No cron scheduling
 * here — that is a later phase.
 *
 * Each pulled record maps 1:1 to ONE import item via the first-class
 * `connector_sync` source + adapter (a flat structured record → one
 * entity-candidate).
 *
 * AGENT GATING: an agent-initiated pull (`agentUserId` present) is routed through
 * `gateCapabilityExecution` as a `read` capability run — consistent with W3's
 * push gating (owner → run, agent → grant-gated). An ungranted agent pull is
 * denied (no auto-pull); the owner/UI path runs directly.
 */

import { createLogger } from "@synap-core/core";
import {
  connectorRegistry,
  isReadable,
  readViaConnector,
  type ReadRequest,
  type ReadResult,
  type Readable,
} from "../connectors/ConnectorRegistry.js";
import { resolveNangoConnector } from "../connectors/index.js";
import { gateCapabilityExecution } from "./capabilities/gate-capability-execution.js";
import { ImportOrchestrator } from "./import-orchestrator.js";
import { NotificationService } from "../notifications/NotificationService.js";

const logger = createLogger({ module: "connector-import-bridge" });

/**
 * First-class connector source. The `connector_sync` adapter maps one record →
 * one entity-candidate (title + metadata + readable key:value body) on the
 * orchestrator's shallow path — correct for flat structured records.
 */
const IMPORT_SOURCE = "connector_sync" as const;

export type PullToImportCtx = {
  workspaceId: string;
  userId: string;
  trpcCtx: Record<string, unknown>;
  /** Active project lens → threaded onto the orchestrator + import proposals. */
  projectId?: string | null;
  /** Session this pull belongs to (groups proposals + produced entities). */
  sessionId?: string | null;
};

/** How an agent-initiated pull is gated (mirrors `gateCapabilityExecution`). */
export type PullGateInput = {
  /** Agent identity when the pull is agent-initiated; absent = owner/UI pull. */
  agentUserId?: string | null;
  /** Capability id of the connector being read (e.g. `read://nango`). */
  capabilityId?: string | null;
  /** Audit issuer label (e.g. `connector.read.import`). */
  issuer?: string | null;
  /** Playbook driving the pull, when any. */
  playbookId?: string | null;
};

/**
 * A connector instance handed to the bridge directly (DI / per-call resolved).
 * It may be a full registry `Readable` OR a bare connector that predates the
 * registry (`NangoConnector` carries `name` but no `type`/`kind`); `ensureReadable`
 * supplies the missing `BaseConnector` fields at runtime. Must expose at least one
 * read surface.
 */
export interface DiConnector {
  // Method shorthand (bivariant) so concrete typed methods on `NangoConnector` /
  // `MessagingConnector` (e.g. `fetchRecords(id: string, …)`) structurally match
  // without forcing the connectors to declare `type`/`kind` (added at runtime by
  // `ensureReadable`). At least one read surface must be present at the call site.
  type?: string;
  name?: string;
  kind?: string;
  read?(req: ReadRequest): Promise<ReadResult>;
  fetchRecords?(...args: unknown[]): Promise<unknown>;
  enrich?(...args: unknown[]): Promise<unknown>;
  getMessages?(...args: unknown[]): Promise<unknown>;
}

export type PullToImportInput = {
  ctx: PullToImportCtx;
  /**
   * The connector to pull from. Either a registry `type` (e.g. "nango",
   * "apify", "unipile") OR a pre-built connector instance (tests / DI / a
   * per-call resolved Nango/messaging connector).
   */
  connector: string | DiConnector;
  /** The canonical read request describing WHAT to pull. */
  request: ReadRequest;
  /** Agent-pull gating (omit for owner/UI pulls). */
  gate?: PullGateInput;
};

export type PullToImportResult = {
  proposalId: string | null;
  /** Number of records the pull returned from the connector. */
  recordCount: number;
  /** Number of items the orchestrator surfaced into the proposal. */
  itemCount: number;
  source: typeof IMPORT_SOURCE;
  /** Set when the agent gate denied or deferred the pull. */
  gated?: "denied" | "deferred";
  gateReason?: string;
};

/** Resolve a `Readable` from the registry by `type`, asserting the capability. */
function resolveReadable(type: string): Readable {
  const c = connectorRegistry.get(type);
  if (!c) {
    throw new Error(`No connector registered for type "${type}".`);
  }
  if (!isReadable(c)) {
    throw new Error(`Connector "${type}" is not Readable.`);
  }
  return c;
}

/**
 * Ensure a DI/bare connector instance satisfies `Readable` (has `type`/`kind`).
 * A per-call resolved `NangoConnector` (env → workspace-settings credentials)
 * carries `name` but no registry `type`, so we wrap it preserving every method
 * (the instance is the prototype, so `read`/`fetchRecords` stay bound).
 */
function ensureReadable(instance: DiConnector): Readable {
  const inst = instance as Readable;
  if (typeof inst.type === "string" && isReadable(inst)) return inst;
  const facade = Object.create(instance) as Readable & {
    type: string;
    kind: "sync" | "enrichment" | "messaging";
  };
  facade.type = (instance as { name?: string }).name ?? "connector";
  facade.kind =
    ((instance as { kind?: string }).kind as
      "sync" | "enrichment" | "messaging" | undefined) ?? "sync";
  return facade;
}

/**
 * Pull from ANY `Readable` connector and land the records as ONE governed
 * import proposal. This is the unified sink the three pull interfaces share.
 *
 * When the connection has no records, returns `{ proposalId: null }` without
 * creating an empty proposal. When an agent pull is denied by the gate, returns
 * `{ proposalId: null, gated: "denied" }` without reading the upstream.
 */
export async function pullToImport(
  input: PullToImportInput
): Promise<PullToImportResult> {
  const { ctx, request, gate } = input;

  const connector =
    typeof input.connector === "string"
      ? resolveReadable(input.connector)
      : ensureReadable(input.connector);

  // ── Agent gating (W4) ──────────────────────────────────────────────────────
  // Only agent-initiated pulls are gated; the owner/UI door reads directly.
  // A connector has no `tools` row (it is resolved per-call), so we gate off a
  // synthesized, unapproved, owner-less capability row keyed by `read://<type>`.
  // With no active grant the gate routes an agent to `propose`/`deny` — never an
  // auto-pull. We treat anything other than `run` as "do not pull".
  if (gate?.agentUserId) {
    const capabilityId = gate.capabilityId ?? `read://${connector.type}`;
    const decision = await gateCapabilityExecution({
      capabilityKind: "tool",
      capabilityId,
      tool: { id: capabilityId, approved: false, createdBy: null },
      actorUserId: gate.agentUserId,
      agentUserId: gate.agentUserId,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId ?? null,
      playbookId: gate.playbookId ?? null,
      issuer: gate.issuer ?? "connector.read.import",
    });
    if (decision.decision !== "run") {
      logger.info(
        {
          connectorType: connector.type,
          agentUserId: gate.agentUserId,
          decision: decision.decision,
          workspaceId: ctx.workspaceId,
        },
        "connector read gated: agent pull not auto-run"
      );
      return {
        proposalId: null,
        recordCount: 0,
        itemCount: 0,
        source: IMPORT_SOURCE,
        gated: decision.decision === "deny" ? "denied" : "deferred",
        gateReason:
          decision.decision === "deny" ? decision.reason : "requires approval",
      };
    }
  }

  const result: ReadResult = await readViaConnector(connector, request);
  const records = result.records;

  if (records.length === 0) {
    logger.info(
      {
        connectorType: connector.type,
        kind: result.kind,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      },
      "connector read: no records to import"
    );
    return {
      proposalId: null,
      recordCount: 0,
      itemCount: 0,
      source: IMPORT_SOURCE,
    };
  }

  // Stable, human-readable per-record path: `<type>/<model>/<i>.json`.
  const items = records.map((r, i) => ({
    path: `${connector.type}/${r.model}/${i}.json`,
    content: JSON.stringify(r.data),
  }));

  const orchestrator = new ImportOrchestrator({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    trpcCtx: ctx.trpcCtx,
    projectId: ctx.projectId ?? null,
  });
  const analyzed = await orchestrator.analyze({
    source: IMPORT_SOURCE,
    items,
    sessionId: ctx.sessionId ?? undefined,
    projectId: ctx.projectId ?? undefined,
  });

  const statsItemCount = (analyzed.stats as { itemCount?: unknown } | undefined)
    ?.itemCount;
  const itemCount =
    typeof statsItemCount === "number" ? statsItemCount : records.length;

  logger.info(
    {
      connectorType: connector.type,
      kind: result.kind,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      recordCount: records.length,
      itemCount,
      proposalId: analyzed.proposalId,
    },
    "connector read → import proposal created"
  );

  return {
    proposalId: analyzed.proposalId,
    recordCount: records.length,
    itemCount,
    source: IMPORT_SOURCE,
  };
}

// ── Back-compat wrapper: Nango sync ──────────────────────────────────────────
//
// The original Nango-only entry point. Kept so the existing `connectors-trpc`
// caller is unchanged; it now delegates to the generalized `pullToImport` with a
// `sync` read request. DI `connector` still wins for tests.

export type SyncConnectionToImportInput = {
  ctx: {
    workspaceId: string;
    userId: string;
    trpcCtx: Record<string, unknown>;
  };
  /** Nango connection id, format `{userId}:{podId}:{provider}`. */
  connectionId: string;
  /** Nango sync model to pull records for (e.g. "Contact", "Issue"). */
  model: string;
  /** Only pull records modified after this instant (incremental sync). */
  since?: Date;
  /** Optional pre-built connector (tests / DI). Defaults to env-config Nango. */
  connector?: DiConnector;
};

export type SyncConnectionToImportResult = {
  proposalId: string | null;
  recordCount: number;
  itemCount: number;
  source: typeof IMPORT_SOURCE;
};

/**
 * Pull records for one Nango connection+model into a single governed import
 * proposal. Thin wrapper over `pullToImport` for the existing tRPC caller.
 */
export async function syncConnectionToImport(
  input: SyncConnectionToImportInput
): Promise<SyncConnectionToImportResult> {
  const { ctx, connectionId, model, since } = input;
  // ONE resolver (env → workspace.settings.nango fallback) — same source the
  // registry + connectors-trpc use. DI `connector` still wins for tests.
  const connector = input.connector ?? (await resolveNangoConnector());

  if (!connector) {
    throw new Error(
      "Nango is not configured on this pod — cannot sync connection to import."
    );
  }

  let result;
  try {
    result = await pullToImport({
      ctx,
      connector,
      request: { kind: "sync", connectionId, model, since },
    });
  } catch (err) {
    // Producer (B3, ONE-DOOR): a genuine SYNC failure notifies the connection
    // OWNER (they reconnect/fix it). Scoped to THIS sync entry — generic agent
    // reads via `pullToImport` do NOT notify, so a transient read blip never
    // fans a high-priority alert (the alert-fatigue anti-pattern). groupKey
    // collapses repeats per provider. Best-effort, non-fatal; the throw is
    // preserved so callers' error handling is unchanged.
    const provider = connectionId.split(":")[2] ?? model;
    await NotificationService.create({
      type: "connector.sync.failed",
      sourceType: "connector",
      sourceId: connectionId,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      groupKey: `${ctx.workspaceId}:connector.sync.failed:${provider}`,
      data: {
        connectorName: provider,
        errorMessage: err instanceof Error ? err.message : "Sync failed",
      },
    }).catch((e) =>
      logger.warn({ e, connectionId }, "connector.sync.failed notify failed")
    );
    throw err;
  }

  return {
    proposalId: result.proposalId,
    recordCount: result.recordCount,
    itemCount: result.itemCount,
    source: result.source,
  };
}
