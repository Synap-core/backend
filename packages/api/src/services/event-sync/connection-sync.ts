/**
 * Connection sync — the ONE door that mirrors a source-provider CONNECTION into
 * Synap entities.
 *
 * TRIGGERS (all land here): on connect (`enqueueConnectionSync` reason
 * `connect`), the CP webhook poke (`webhook`), and the scheduled tick
 * (`runScheduledConnectionSyncs`). Enqueued runs execute on the pg-boss
 * `connection-sync-run` queue.
 *
 * CONFIG vs STATE. The connection's provider tool row carries both, under
 * `metadata.sync`:
 *   - `sync.enabled`, `sync.kinds.<kind>.{enabled,windowDays,itemLimit,sources}`
 *     — template defaults (nango-google.capability.json) ⊕ user override; a
 *     reconcile merges the template UNDER existing values, so overrides survive.
 *   - `sync.kinds.<kind>.connections.<connectionId>` — per-CONNECTION run state
 *     (`cursor`, `phase`, `counts`, `proposalId`, `error`, `pageToken`, lease).
 *     Keyed by connection because one workspace's tool row serves every
 *     member's connection, and each member's mirror has its own cursor.
 *
 * PHASE SWITCH, per connection:
 *   - FIRST run (no cursor) of every enabled kind → one bounded read per kind
 *     (`windowDays` / `itemLimit`) → ONE merged graph → ONE `import.graph`
 *     proposal (`data.connectionSync.keepSyncing: true`) → `review_ready`.
 *     While that proposal is pending, the kind waits (no duplicate proposals).
 *   - STEADY run → `resolveConnectionSyncDecision` (the connection's rule):
 *       `auto`    → page-by-page upsert through `EntityUpsertService`
 *                   (external link → kind dedup → strong identity signals),
 *                   each write emitted with `origin: "sync"` so search index +
 *                   embeddings run and non-opted automations do not;
 *       `propose` → one grouped proposal (`keepSyncing: false` — approving a
 *                   one-off review must not re-arm a rule the user turned off).
 *
 * RESUMABILITY. A steady auto run checkpoints `pageToken` after every landed
 * page, so a crash resumes from the next page with the same `since`. A
 * proposal-building run is bounded (itemLimit) and holds its graph in memory; a
 * crash re-reads it, and the content idempotency key returns the prior proposal
 * instead of filing a clone. Leases (15 min) keep two triggers from running the
 * same connection × kind at once and expire on their own after a crash.
 *
 * FAILURES are recorded, never swallowed: phase `failed` + `error` on the state,
 * a `failed` progress event, and a reconnect nudge for an auth failure.
 */

import { z } from "zod";
import { createLogger } from "@synap-core/core";
import {
  db,
  getDb,
  tools,
  eq,
  and,
  inArray,
  isNull,
  EntityUpsertService,
  RelationRepository,
  eventRepository,
  extractSignalsFromProperties,
  resolveIdentity,
  resolveConnectionSyncDecision,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { emitSideEffects, getBoss } from "@synap/events";
import {
  humanizeToken,
  resolveObjectNounPlural,
} from "@synap-core/types/vocabulary";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import {
  acquireLease,
  findApprovedConnectionImport,
  isProviderSyncEnabled,
  patchKindState,
  proposalStatus,
  readKindState,
  readOwnedConnectionIds,
  renewLease,
  resolveSyncConnections,
  resolveSyncTool,
  type KindStateKey,
  type KindSyncState,
} from "./sync-state-store.js";
import { scopeSyncStatusToUser } from "../../connectors/sync-status-scope.js";
import { makeExternalLinkIdempotency } from "../../utils/entity-link-idempotency.js";
import {
  isConnectionAuthError,
  notifyConnectorUnhealthy,
  resolveNoticeChannelId,
} from "../connection-health/notify-connector-unhealthy.js";
import { submitSyncGraphToImport } from "../connector-import-bridge.js";
import { importGraphIdempotencyKey } from "../import/structuring.js";
import { findRejectedConnectionSyncImport } from "../../utils/pending-capture-dedup.js";
import { recordDomainMutation } from "../../utils/domain-mutation.js";
import {
  emptySyncGraph,
  mergeSyncGraph,
  type SyncGraph,
  type SyncGraphEntity,
} from "./sync-graph.js";
import {
  getSyncKinds,
  getSyncProviders,
  type ResolvedKindSyncConfig,
  type SyncCounts,
  type SyncKindContext,
  type SyncKindHandler,
  type SyncPhase,
  type SyncProfileCounts,
} from "./sync-kind-registry.js";
import "./google-sync-kinds.js";

export {
  registerSyncKind,
  getSyncKinds,
  getSyncProviders,
  type ResolvedKindSyncConfig,
  type SyncCounts,
  type SyncFetchPage,
  type SyncFetchRequest,
  type SyncKindContext,
  type SyncKindHandler,
  type SyncPhase,
  type SyncProfileCounts,
} from "./sync-kind-registry.js";
export {
  isProviderSyncEnabled,
  readKindState,
  type KindSyncState,
} from "./sync-state-store.js";

const logger = createLogger({ module: "connection-sync" });

/** The pg-boss queue runs are enqueued on. Mirrors `CONNECTION_SYNC_RUN_QUEUE` in @synap/jobs (pinned by connection-sync.test.ts). */
export const CONNECTION_SYNC_QUEUE = "connection-sync-run";
/** Duplicate triggers for one connection inside this window collapse into one job. */
const ENQUEUE_DEBOUNCE_SECONDS = 30;
const DAY_MS = 86_400_000;

export type SyncTriggerReason = "connect" | "cron" | "webhook" | "manual";

// ── Stored shapes ────────────────────────────────────────────────────────────────

export interface StoredKindSyncConfig {
  enabled?: boolean;
  windowDays?: number;
  itemLimit?: number;
  sources?: string[];
  connections?: Record<string, KindSyncState>;
}

export interface ProviderSyncConfig {
  /** Master enable for this connection tool's sync. */
  enabled?: boolean;
  /** Pin the sync to ONE connection (secrets row) for this provider. */
  connectionId?: string;
  /** Optional channel (external id) for connection-health nudges. */
  announceChannelId?: string;
  kinds?: Record<string, StoredKindSyncConfig>;
}

interface ProviderToolMetadata {
  sync?: ProviderSyncConfig;
  [k: string]: unknown;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

export function resolveKindConfig(
  handler: SyncKindHandler,
  syncCfg: ProviderSyncConfig | undefined
): ResolvedKindSyncConfig {
  const stored = syncCfg?.kinds?.[handler.kind] ?? {};
  return {
    enabled:
      typeof stored.enabled === "boolean"
        ? stored.enabled
        : handler.defaults.enabled,
    windowDays: positiveInt(stored.windowDays, handler.defaults.windowDays),
    itemLimit: positiveInt(stored.itemLimit, handler.defaults.itemLimit),
    sources: Array.isArray(stored.sources)
      ? stored.sources.filter((s): s is string => typeof s === "string")
      : handler.defaults.sources,
  };
}

// ── Progress ─────────────────────────────────────────────────────────────────────

function zeroCounts(): SyncCounts {
  return { fetched: 0, created: 0, merged: 0, skipped: 0, byProfile: {} };
}

/** Tally one entity outcome under its profile — what a run FOUND, not what it read. */
function tallyProfile(
  byProfile: SyncProfileCounts,
  profileSlug: string,
  outcome: "created" | "merged",
  n = 1
): void {
  const tally = (byProfile[profileSlug] ??= { created: 0, merged: 0 });
  tally[outcome] += n;
}

/** One connection × kind inside a run: its context, state, and phase reporter. */
class KindRun {
  phase: SyncPhase | undefined;
  counts: SyncCounts;
  proposalId: string | undefined;
  error: string | undefined;
  /** The read stopped at `itemLimit` with records still unread. */
  truncated = false;

  constructor(
    readonly handler: SyncKindHandler,
    readonly ctx: SyncKindContext,
    readonly state: KindSyncState
  ) {
    this.counts = zeroCounts();
  }

  /** Persist state and emit a progress event when the phase changes. */
  async advance(phase: SyncPhase, patch: KindSyncState = {}): Promise<void> {
    const changed = phase !== this.phase;
    this.phase = phase;
    await patchKindState(this.ctx, { ...patch, phase, counts: this.counts });
    if (changed) await emitProgress(this);
  }

  /** Extend the lease at a page boundary, so a long read is not taken over. */
  renew(): Promise<void> {
    return renewLease(this.ctx);
  }

  /** Terminal phase: stamp lastRunAt, release the lease. */
  async finish(phase: SyncPhase, patch: KindSyncState = {}): Promise<void> {
    await this.advance(phase, {
      ...patch,
      lastRunAt: new Date().toISOString(),
      leaseUntil: null,
    });
  }

  async fail(err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.error = message;
    logger.warn(
      {
        err,
        provider: this.ctx.provider,
        kind: this.ctx.kind,
        connectionId: this.ctx.connectionId,
      },
      "connection sync: kind run failed"
    );
    // pageToken + cursor are left as they were, so the next run resumes.
    await this.finish("failed", { error: message });
    if (isConnectionAuthError(message)) {
      await notifyConnectorUnhealthy({
        connectorKey: this.ctx.provider,
        connectorName: humanizeToken(this.ctx.provider),
        reconnectHint: "Reconnect it in the app (Settings → Connections).",
        userId: this.ctx.owner,
        workspaceId: this.ctx.workspaceId,
        watermarkToolId: this.ctx.toolId,
        watermarkMetadata: this.ctx.toolMetadata,
        discordTeamChannelId: resolveNoticeChannelId(
          this.ctx.toolMetadata,
          (this.ctx.toolMetadata.sync as ProviderSyncConfig | undefined)
            ?.announceChannelId
        ),
        errorMessage: message,
      });
    }
  }

  result(): KindSyncResult {
    return {
      phase: this.phase ?? "failed",
      counts: this.counts,
      ...(this.proposalId ? { proposalId: this.proposalId } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }
}

async function emitProgress(run: KindRun): Promise<void> {
  await emitSideEffects({
    subjectType: "connection_sync",
    action: "progress",
    subjectId: run.ctx.connectionId,
    userId: run.ctx.owner,
    workspaceId: run.ctx.workspaceId,
    data: {
      provider: run.ctx.provider,
      kind: run.ctx.kind,
      phase: run.phase,
      counts: run.counts,
      ...(run.proposalId ? { proposalId: run.proposalId } : {}),
      ...(run.error ? { error: run.error } : {}),
    },
    origin: "sync",
  });
}

// ── Reading ──────────────────────────────────────────────────────────────────────

interface ReadWindow {
  mode: "initial" | "steady";
  since: string | null;
  windowStart: string;
  windowEnd: string;
}

function readWindow(run: KindRun, mode: "initial" | "steady"): ReadWindow {
  const now = Date.now();
  const span = run.ctx.kindConfig.windowDays * DAY_MS;
  return {
    mode,
    since: mode === "steady" ? (run.state.cursor ?? null) : null,
    windowStart: new Date(now - span).toISOString(),
    windowEnd: new Date(now + span).toISOString(),
  };
}

/**
 * Read pages from `pageToken` until `itemLimit` (per call) or the last page and
 * fold them into one graph. `nextPageToken` is non-null when the limit stopped
 * the read with records still unread.
 */
async function readAll(
  run: KindRun,
  window: ReadWindow,
  pageToken: string | null = null
): Promise<{ graph: SyncGraph; nextPageToken: string | null }> {
  const graph = emptySyncGraph();
  const limit = run.ctx.kindConfig.itemLimit;
  let fetched = 0;
  do {
    const remaining = limit - fetched;
    const page = await run.handler.fetchPage(run.ctx, {
      ...window,
      pageToken,
      pageSize: remaining,
    });
    const items = page.items.slice(0, remaining);
    fetched += items.length;
    run.counts.fetched += items.length;
    const mapped = run.handler.mapItems(items);
    run.counts.skipped += mapped.skipped;
    mergeSyncGraph(graph, mapped.graph);
    pageToken = page.nextPageToken;
    if (pageToken && fetched < limit) await run.renew();
  } while (pageToken && fetched < limit);
  run.truncated = pageToken !== null;
  return { graph, nextPageToken: pageToken };
}

// ── Writing ──────────────────────────────────────────────────────────────────────

async function findExistingAcross(
  handlers: SyncKindHandler[],
  entity: SyncGraphEntity,
  ctx: SyncKindContext
): Promise<string | null> {
  for (const h of handlers) {
    if (!h.findExisting) continue;
    const id = await h.findExisting(entity, ctx);
    if (id) return id;
  }
  return null;
}

function linkIdempotency(owner: string, source: string) {
  return makeExternalLinkIdempotency(db, {
    namespace: "connection-sync",
    provider: source,
    userId: owner,
  });
}

/**
 * Graph → composite operations for ONE proposal. An entity already in the pod
 * (external link → kind dedup → strong identity signal) is pinned as
 * `existingEntityId`, so approval links rather than duplicates.
 */
export async function buildSyncGraphOperations(
  graph: SyncGraph,
  handlers: SyncKindHandler[],
  ctx: SyncKindContext
): Promise<{
  operations: CompositeProposalOperation[];
  /** ref → the entity it already matches in the pod. */
  existingIds: Map<string, string>;
}> {
  const operations: CompositeProposalOperation[] = [];
  const existingIds = new Map<string, string>();
  for (const e of graph.entities) {
    const existingId =
      (await linkIdempotency(ctx.owner, e.identity.source).lookup(
        e.identity.source,
        e.identity.externalId
      )) ??
      (await findExistingAcross(handlers, e, ctx)) ??
      (await strongIdentityMatch(e, ctx.owner));
    if (existingId) existingIds.set(e.ref, existingId);
    operations.push({
      op: "create_entity",
      ref: e.ref,
      profileSlug: e.profileSlug,
      title: e.title,
      properties: e.properties,
      // Approval registers these through the link door, so the approved
      // import carries provider link + url + connection stamp immediately.
      externalLinks: [
        {
          provider: e.identity.source,
          externalId: e.identity.externalId,
          url: e.identity.url,
          connectionId: ctx.connectionId,
        },
      ],
      ...(existingId ? { existingEntityId: existingId } : {}),
    });
  }
  for (const r of graph.relations) {
    operations.push({
      op: "create_relation",
      type: r.type,
      sourceRef: r.sourceRef,
      targetRef: r.targetRef,
    });
  }
  return { operations, existingIds };
}

/**
 * File a graph for review as ONE `import.graph` — unless the owner already
 * REJECTED this exact graph for this connection and kinds. A sync re-reads the
 * same records every run; a declined import is not asked again until its
 * content changes. Returns the proposal id, or null when nothing was filed.
 */
async function fileSyncProposal(
  ctx: SyncKindContext,
  kinds: string[],
  operations: CompositeProposalOperation[],
  summary: string,
  keepSyncing: boolean
): Promise<string | null> {
  const idempotencyKey = importGraphIdempotencyKey({
    workspaceId: ctx.workspaceId,
    operations,
  });
  if (idempotencyKey) {
    const rejected = await findRejectedConnectionSyncImport(db, {
      userId: ctx.owner,
      idempotencyKey,
      connectionId: ctx.connectionId,
      kinds,
    });
    if (rejected) return null;
  }
  const { proposalId } = await submitSyncGraphToImport({
    userId: ctx.owner,
    workspaceId: ctx.workspaceId,
    operations,
    summary,
    connectionSync: {
      connectionId: ctx.connectionId,
      provider: ctx.provider,
      kinds,
      keepSyncing,
    },
  });
  return proposalId;
}

/**
 * Where a finished read leaves the kind's window. An exhausted read moves the
 * cursor to the run's start. A read the item limit stopped keeps the cursor and
 * stores the next page, so the next run resumes it with the same `since` —
 * moving the cursor would skip every unread record.
 */
function windowCheckpoint(
  runStartedAt: string,
  nextPageToken: string | null
): KindSyncState {
  return nextPageToken
    ? { runStartedAt, pageToken: nextPageToken }
    : { cursor: runStartedAt, runStartedAt: null, pageToken: null };
}

async function strongIdentityMatch(
  entity: SyncGraphEntity,
  owner: string
): Promise<string | null> {
  const signals = extractSignalsFromProperties(
    entity.properties,
    entity.identity.source
  );
  if (signals.length === 0) return null;
  const resolution = await resolveIdentity(db, { userId: owner, signals });
  return resolution.match === "strong" && resolution.entity
    ? resolution.entity.id
    : null;
}

/** Is THIS write (subject × action) auto-approved by the connection's rule? */
export type SyncWriteGate = (
  subjectType: "entity" | "relation",
  action: "create" | "update"
) => Promise<boolean>;

/** One rule evaluation per (subject, action) per run — the floors differ by action. */
function makeWriteGate(ctx: SyncKindContext): SyncWriteGate {
  const memo = new Map<string, Promise<boolean>>();
  return (subjectType, action) => {
    const key = `${subjectType}.${action}`;
    let verdict = memo.get(key);
    if (!verdict) {
      verdict = resolveConnectionSyncDecision({
        userId: ctx.owner,
        workspaceId: ctx.workspaceId,
        connectionId: ctx.connectionId,
        subjectType,
        action,
      }).then((d) => d.verdict === "auto");
      memo.set(key, verdict);
    }
    return verdict;
  };
}

export interface UpsertSyncGraphResult {
  created: number;
  merged: number;
  /** Matched entities whose refresh the rule did not auto-approve (not written). */
  refreshSkipped: number;
  /** `created` / `merged` per profile slug. */
  byProfile: SyncProfileCounts;
  /** Writes the rule did not auto-approve — filed for review, never written. */
  deferred: SyncGraph;
}

/**
 * Steady `auto`: land a graph through `EntityUpsertService` and its relations
 * through the relation repository. Each write is gated on the connection rule
 * for ITS action (entity create, entity update, relation create) and recorded
 * through `recordDomainMutation` with `origin: "sync"` (event log + fan-out).
 */
export async function upsertSyncGraph(
  graph: SyncGraph,
  handlers: SyncKindHandler[],
  ctx: SyncKindContext,
  gate: SyncWriteGate = makeWriteGate(ctx)
): Promise<UpsertSyncGraphResult> {
  const database = await getDb();
  const upserter = new EntityUpsertService(database, eventRepository);
  const relationRepo = new RelationRepository(database, eventRepository);
  const refToId = new Map<string, string>();
  const deferred = emptySyncGraph();
  const byRef = new Map(graph.entities.map((e) => [e.ref, e]));
  let created = 0;
  let merged = 0;
  let refreshSkipped = 0;
  const byProfile: SyncProfileCounts = {};

  const deferEntity = (e: SyncGraphEntity) => {
    if (!deferred.entities.some((d) => d.ref === e.ref))
      deferred.entities.push(e);
  };

  for (const e of graph.entities) {
    const idem = linkIdempotency(ctx.owner, e.identity.source);
    // Kind dedup BEFORE the upsert: an adopted entity gets the provider link, so
    // the upsert's exact external-link step lands on it instead of creating.
    let knownId = await idem.lookup(e.identity.source, e.identity.externalId);
    if (!knownId) {
      const adopted = await findExistingAcross(handlers, e, ctx);
      if (adopted) {
        await idem.register(adopted, e.identity.source, e.identity.externalId);
        knownId = adopted;
      }
    }
    // A write that would CREATE needs the rule's create verdict.
    if (!knownId && !(await strongIdentityMatch(e, ctx.owner))) {
      if (!(await gate("entity", "create"))) {
        deferEntity(e);
        continue;
      }
    }
    const res = await upserter.upsert({
      profileSlug: e.profileSlug,
      title: e.title,
      properties: e.properties,
      source: e.identity.source,
      externalId: e.identity.externalId,
      url: e.identity.url,
      // Which user's connection produced this link (Places opens only the
      // caller's own) — stamped on `nango_connection_id`.
      connectionId: ctx.connectionId,
      signals: extractSignalsFromProperties(e.properties, e.identity.source),
      workspaceId: ctx.workspaceId,
      userId: ctx.owner,
      provenance: { createdByKind: "system", createdByUserId: ctx.owner },
    });
    refToId.set(e.ref, res.entity.id);
    if (res.action === "created") {
      created += 1;
      tallyProfile(byProfile, e.profileSlug, "created");
      await recordSyncWrite(ctx, "entity", "create", res.entity.id, {
        profileSlug: e.profileSlug,
        source: ctx.provider,
      });
    } else {
      merged += 1;
      tallyProfile(byProfile, e.profileSlug, "merged");
      if (!handlers.some((h) => h.refreshExisting)) continue;
      // A refresh WRITES the matched entity — it needs the update verdict.
      if (!(await gate("entity", "update"))) {
        refreshSkipped += 1;
        continue;
      }
      let refreshed = false;
      for (const h of handlers) {
        if (h.refreshExisting && (await h.refreshExisting(res.entity.id, e))) {
          refreshed = true;
        }
      }
      if (refreshed) {
        await recordSyncWrite(ctx, "entity", "update", res.entity.id, {
          profileSlug: e.profileSlug,
          source: ctx.provider,
        });
      }
    }
  }

  const relationIdem = linkIdempotency(ctx.owner, ctx.provider);
  for (const r of graph.relations) {
    const sourceDeferred = !refToId.has(r.sourceRef);
    const targetDeferred = !refToId.has(r.targetRef);
    if (sourceDeferred || targetDeferred) {
      // An endpoint was deferred: the edge goes to review with it, and the
      // landed endpoint rides along (pinned as existing when the proposal is built).
      for (const ref of [r.sourceRef, r.targetRef]) {
        const endpoint = byRef.get(ref);
        if (endpoint) deferEntity(endpoint);
      }
      deferred.relations.push(r);
      continue;
    }
    const sourceId = refToId.get(r.sourceRef)!;
    const targetId = refToId.get(r.targetRef)!;
    if (sourceId === targetId) continue;
    if (await relationIdem.relationExists(sourceId, targetId, r.type)) continue;
    if (!(await gate("relation", "create"))) {
      deferEntity(byRef.get(r.sourceRef)!);
      deferEntity(byRef.get(r.targetRef)!);
      deferred.relations.push(r);
      continue;
    }
    const relation = await relationRepo.create(
      {
        sourceEntityId: sourceId,
        targetEntityId: targetId,
        type: r.type,
        workspaceId: ctx.workspaceId,
        userId: ctx.owner,
        createdByKind: "system",
        createdByUserId: ctx.owner,
      },
      ctx.owner
    );
    await recordSyncWrite(ctx, "relation", "create", relation.id, {
      type: r.type,
      sourceEntityId: sourceId,
      targetEntityId: targetId,
      source: ctx.provider,
    });
  }
  return { created, merged, refreshSkipped, byProfile, deferred };
}

/**
 * The canonical mutation record for a sync write: the event log row + the
 * side-effect fan-out, tagged `origin: "sync"` (index/embeddings run; event
 * automations skip unless opted in).
 */
async function recordSyncWrite(
  ctx: SyncKindContext,
  subjectType: "entity" | "relation",
  action: "create" | "update",
  subjectId: string,
  data: Record<string, unknown>
): Promise<void> {
  await recordDomainMutation({
    subjectType,
    action,
    subjectId,
    userId: ctx.owner,
    workspaceId: ctx.workspaceId,
    source: "connection_sync",
    data,
    origin: "sync",
  });
}

// ── Run modes ────────────────────────────────────────────────────────────────────

/** Steady `auto`: page → upsert → checkpoint, resumable from `pageToken`. */
async function runAuto(run: KindRun): Promise<void> {
  const resuming = !!run.state.pageToken && !!run.state.runStartedAt;
  const runStartedAt = resuming
    ? run.state.runStartedAt!
    : new Date().toISOString();
  if (resuming && run.state.counts) {
    run.counts = { ...zeroCounts(), ...structuredClone(run.state.counts) };
  }
  const window = readWindow(run, "steady");
  const limit = run.ctx.kindConfig.itemLimit;
  let pageToken: string | null = resuming ? run.state.pageToken! : null;

  const gate = makeWriteGate(run.ctx);
  // Writes the rule did not auto-approve, gathered across pages and filed as
  // ONE proposal for the run.
  const deferred = emptySyncGraph();
  // The item budget is per call: a run resuming a truncated read reads a fresh
  // `itemLimit`, while `counts` keep adding up until the cursor moves.
  let fetched = 0;

  await run.advance("fetching", { runStartedAt, pageToken, error: null });
  do {
    const remaining = limit - fetched;
    const page = await run.handler.fetchPage(run.ctx, {
      ...window,
      pageToken,
      pageSize: remaining,
    });
    const items = page.items.slice(0, remaining);
    fetched += items.length;
    run.counts.fetched += items.length;
    const mapped = run.handler.mapItems(items);
    run.counts.skipped += mapped.skipped;
    await run.advance("mapping");
    const landed = await upsertSyncGraph(
      mapped.graph,
      [run.handler],
      run.ctx,
      gate
    );
    run.counts.created += landed.created;
    run.counts.merged += landed.merged;
    run.counts.skipped += landed.refreshSkipped;
    for (const [slug, t] of Object.entries(landed.byProfile)) {
      const into = (run.counts.byProfile ??= {});
      tallyProfile(into, slug, "created", t.created);
      tallyProfile(into, slug, "merged", t.merged);
    }
    mergeSyncGraph(deferred, landed.deferred);
    pageToken = page.nextPageToken;
    // Checkpoint AFTER the page landed, and only while nothing is held for
    // review: a resumed run never re-reads a checkpointed page, so a deferred
    // write behind a checkpoint would be lost. A crash re-reads from the last
    // checkpoint, and landed writes match their external link again.
    const holding =
      deferred.entities.length > 0 || deferred.relations.length > 0;
    if (pageToken && fetched < limit && !holding) {
      await run.advance("fetching", { runStartedAt, pageToken });
    }
    if (pageToken && fetched < limit) await run.renew();
  } while (pageToken && fetched < limit);
  run.truncated = pageToken !== null;

  let filedProposalId: string | null = null;
  if (deferred.entities.length > 0 || deferred.relations.length > 0) {
    const { operations } = await buildSyncGraphOperations(
      deferred,
      [run.handler],
      run.ctx
    );
    filedProposalId = await fileSyncProposal(
      run.ctx,
      [run.ctx.kind],
      operations,
      syncProposalSummary([run], "steady"),
      false
    );
    if (filedProposalId) run.proposalId = filedProposalId;
  }

  // Writes held for review make this run's outcome a review, not a clean sync.
  await run.finish(filedProposalId ? "review_ready" : "synced", {
    ...windowCheckpoint(runStartedAt, pageToken),
    error: null,
    ...(filedProposalId ? { proposalId: filedProposalId } : {}),
  });
}

/**
 * Initial kinds (or steady kinds under `propose`) of ONE connection: read each
 * kind, merge into one graph, file ONE proposal for all of them.
 */
async function runGroupedProposal(
  runs: KindRun[],
  mode: "initial" | "steady"
): Promise<void> {
  const now = new Date().toISOString();
  const graph = emptySyncGraph();
  const refKind = new Map<string, KindRun>();
  const read: KindRun[] = [];
  /** Per kind: the window start it keeps, and the page it stopped before. */
  const window = new Map<
    KindRun,
    { runStartedAt: string; nextPageToken: string | null }
  >();

  for (const run of runs) {
    try {
      // A steady read the item limit stopped resumes its page with its window.
      const resume =
        mode === "steady" && run.state.pageToken && run.state.runStartedAt
          ? {
              pageToken: run.state.pageToken,
              runStartedAt: run.state.runStartedAt,
            }
          : null;
      const runStartedAt = resume?.runStartedAt ?? now;
      await run.advance("fetching", { runStartedAt, error: null });
      const { graph: kindGraph, nextPageToken } = await readAll(
        run,
        readWindow(run, mode),
        resume?.pageToken ?? null
      );
      for (const e of kindGraph.entities) {
        if (!refKind.has(e.ref)) refKind.set(e.ref, run);
      }
      mergeSyncGraph(graph, kindGraph);
      read.push(run);
      // The first import is a bounded read by design: its cursor moves even
      // when truncated, and its summary says the window was not covered.
      window.set(run, {
        runStartedAt,
        nextPageToken: mode === "steady" ? nextPageToken : null,
      });
    } catch (err) {
      await run.fail(err);
    }
  }
  if (read.length === 0) return;

  const checkpoint = (run: KindRun) => {
    const w = window.get(run)!;
    return windowCheckpoint(w.runStartedAt, w.nextPageToken);
  };

  for (const run of read) await run.advance("mapping");
  const ctx = read[0]!.ctx;
  const handlers = read.map((r) => r.handler);

  try {
    const { operations, existingIds } = await buildSyncGraphOperations(
      graph,
      handlers,
      ctx
    );
    for (const e of graph.entities) {
      const owner = refKind.get(e.ref);
      if (!owner) continue;
      const outcome = existingIds.has(e.ref) ? "merged" : "created";
      owner.counts[outcome] += 1;
      tallyProfile((owner.counts.byProfile ??= {}), e.profileSlug, outcome);
    }

    // New = an entity with no match, or an edge between matched entities that
    // does not exist yet. A re-read of records already in the pod (every
    // contact re-emits its `works_at`) is not new.
    const relationIdem = linkIdempotency(ctx.owner, ctx.provider);
    let newRelations = 0;
    for (const r of graph.relations) {
      const sourceId = existingIds.get(r.sourceRef);
      const targetId = existingIds.get(r.targetRef);
      const exists =
        !!sourceId &&
        !!targetId &&
        (sourceId === targetId ||
          (await relationIdem.relationExists(sourceId, targetId, r.type)));
      if (!exists) newRelations += 1;
    }
    const nothingNew =
      graph.entities.every((e) => existingIds.has(e.ref)) && newRelations === 0;

    const kinds = read.map((r) => r.ctx.kind);
    const proposalId = nothingNew
      ? null
      : await fileSyncProposal(
          ctx,
          kinds,
          operations,
          syncProposalSummary(read, mode),
          mode === "initial"
        );
    for (const run of read) {
      if (proposalId) run.proposalId = proposalId;
      await run.finish(proposalId ? "review_ready" : "synced", {
        ...checkpoint(run),
        proposalId,
        error: null,
      });
    }
  } catch (err) {
    for (const run of read) await run.fail(err);
  }
}

/** "a", "a and b", "a, b and c". */
function listSentence(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function syncProposalSummary(
  runs: KindRun[],
  mode: "initial" | "steady"
): string {
  const provider = humanizeToken(runs[0]!.ctx.provider);
  const created = runs.reduce((n, r) => n + r.counts.created, 0);
  const merged = runs.reduce((n, r) => n + r.counts.merged, 0);
  // Kind nouns inside a sentence: the vocabulary plural, lowercased, as the
  // connectors model phrases them ("Brings events and contacts").
  const kindNoun = (r: KindRun) =>
    resolveObjectNounPlural(r.ctx.kind).toLowerCase();
  const kinds = listSentence(runs.map(kindNoun));
  const days = Math.max(...runs.map((r) => r.ctx.kindConfig.windowDays));
  // A read the item limit stopped does not cover its window — never claim it does.
  const truncated = runs
    .filter((r) => r.truncated)
    .map((r) => `${kindNoun(r)} (${r.ctx.kindConfig.itemLimit} records)`);
  const scope =
    mode === "steady"
      ? `${provider} sync`
      : truncated.length === 0
        ? `first ${provider} sync, last ${days} days`
        : `first ${provider} sync; reading stopped at the limit for ${listSentence(truncated)}, so it does not cover all of the last ${days} days`;
  // Consent to keep syncing is carried by `data.connectionSync`, which clients
  // render as its own row and switch — never repeated in this text.
  return `${created} new and ${merged} matching records from ${kinds} (${scope})`;
}

// ── Runner ───────────────────────────────────────────────────────────────────────

export type KindSyncResult =
  | { skipped: true; reason: string; proposalId?: string }
  | {
      phase: SyncPhase;
      counts: SyncCounts;
      proposalId?: string;
      error?: string;
    };

export interface RunConnectionSyncResult {
  skipped?: boolean;
  reason?: string;
  provider?: string;
  connections?: Array<{
    connectionId: string;
    kinds: Record<string, KindSyncResult>;
  }>;
}

/**
 * Sync ONE provider connection tool → Synap entities. The ONE runner every
 * trigger reaches (directly for the scheduled tick, via the queue otherwise).
 */
export async function runConnectionSync(opts: {
  /** Provider connection tool name, e.g. `"google"`. */
  provider: string;
  /** Caller workspace: narrows to that workspace's tool row. */
  workspaceId?: string | null;
  /** Sync only this connection (secrets row). */
  connectionId?: string;
  /** Pin the exact tool row (the scheduled tick walks rows explicitly). */
  toolId?: string;
  reason?: SyncTriggerReason;
}): Promise<RunConnectionSyncResult> {
  const handlers = getSyncKinds(opts.provider);
  if (handlers.length === 0) {
    return { skipped: true, reason: "no_sync_kinds_registered" };
  }

  const tool = await resolveSyncTool(opts);
  if (!tool) {
    return {
      skipped: true,
      reason: opts.connectionId
        ? "connection_not_found"
        : `no_${opts.provider}_tool`,
      provider: opts.provider,
    };
  }
  const metadata = (tool.metadata ?? {}) as ProviderToolMetadata;
  const syncCfg = metadata.sync;
  if (syncCfg?.enabled !== true) {
    return { skipped: true, reason: "sync_disabled", provider: opts.provider };
  }

  const connections = await resolveSyncConnections(
    tool.id,
    opts.connectionId ?? syncCfg.connectionId
  );
  if (connections.length === 0) {
    // Sync is ON for this tool row but no live connection registry row backs
    // it — a reconnect is needed. Surfaced, never a silent no-op.
    logger.warn(
      { provider: opts.provider, toolId: tool.id, reason: opts.reason },
      "connection sync: sync enabled but no live connection"
    );
    return { skipped: true, reason: "no_connection", provider: opts.provider };
  }

  const workspaceId = tool.workspaceId ?? opts.workspaceId ?? null;
  const out: NonNullable<RunConnectionSyncResult["connections"]> = [];

  for (const conn of connections) {
    const kinds: Record<string, KindSyncResult> = {};
    const initial: KindRun[] = [];
    const steady: KindRun[] = [];

    for (const handler of handlers) {
      const kindConfig = resolveKindConfig(handler, syncCfg);
      if (!kindConfig.enabled) {
        kinds[handler.kind] = { skipped: true, reason: "kind_disabled" };
        continue;
      }
      const leased = await acquireLease({
        toolId: tool.id,
        kind: handler.kind,
        connectionId: conn.id,
      });
      if (leased === null) {
        kinds[handler.kind] = { skipped: true, reason: "already_running" };
        continue;
      }
      const ctx: SyncKindContext = {
        provider: opts.provider,
        kind: handler.kind,
        owner: conn.userId,
        workspaceId,
        connectionId: conn.id,
        kindConfig,
        toolId: tool.id,
        toolMetadata: metadata as Record<string, unknown>,
      };
      const state = readKindState(leased, handler.kind, conn.id);
      const run = new KindRun(handler, ctx, state);

      if (state.phase === "review_ready" && state.proposalId) {
        const status = await proposalStatus(state.proposalId);
        if (status === ProposalStatus.PENDING) {
          await patchKindState(ctx, { leaseUntil: null });
          kinds[handler.kind] = {
            skipped: true,
            reason: "awaiting_review",
            proposalId: state.proposalId,
          };
          continue;
        }
      }
      (state.cursor ? steady : initial).push(run);
    }

    if (initial.length > 0) await runGroupedProposal(initial, "initial");

    if (steady.length > 0) {
      // The connection's rule. Approving the first import mints it for BOTH
      // workspace-scoped and pod-wide proposals (the proposal approval door), so a
      // steady run only reads it — it never mints one itself.
      const decision = await resolveConnectionSyncDecision({
        userId: conn.userId,
        // The SAME workspace the grouped proposal was filed under — rules are
        // workspace-scoped.
        workspaceId,
        connectionId: conn.id,
      });
      if (decision.verdict === "auto") {
        for (const run of steady) {
          try {
            await runAuto(run);
          } catch (err) {
            await run.fail(err);
          }
        }
      } else {
        await runGroupedProposal(steady, "steady");
      }
    }

    const ran = [...initial, ...steady];
    for (const run of ran) {
      kinds[run.ctx.kind] = run.result();
    }
    if (ran.length > 0) {
      await recordRunCompleted(opts.provider, conn, workspaceId, ran);
    }
    out.push({ connectionId: conn.id, kinds });
  }

  logger.info(
    { provider: opts.provider, reason: opts.reason, connections: out },
    "connection sync run complete"
  );
  return { provider: opts.provider, connections: out };
}

/**
 * `connector_sync.complete.completed` — ONE fact per connection per run, once
 * every kind that ran has finished. It is a run fact, not a mirrored write, so
 * it carries no `origin` and event automations fire on it without opting in.
 * `counts.created` / `counts.merged` of a kind in `review_ready` are proposed,
 * not yet written.
 */
async function recordRunCompleted(
  provider: string,
  conn: { id: string; userId: string },
  workspaceId: string | null,
  runs: KindRun[]
): Promise<void> {
  const sum = (key: "fetched" | "created" | "merged" | "skipped") =>
    runs.reduce((n, r) => n + r.counts[key], 0);
  const proposalIds = [
    ...new Set(
      runs.map((r) => r.proposalId).filter((id): id is string => !!id)
    ),
  ];
  await recordDomainMutation({
    subjectType: "connector_sync",
    action: "complete",
    subjectId: conn.id,
    userId: conn.userId,
    workspaceId,
    source: "connection_sync",
    data: {
      provider,
      connectionId: conn.id,
      syncStatus: runs.some((r) => r.phase === "failed") ? "error" : "success",
      kinds: Object.fromEntries(
        runs.map((r) => [r.ctx.kind, r.phase ?? "failed"])
      ),
      counts: {
        fetched: sum("fetched"),
        created: sum("created"),
        merged: sum("merged"),
        skipped: sum("skipped"),
      },
      ...(proposalIds.length > 0 ? { proposalIds } : {}),
    },
  });
}

/** Scheduled tick: every sync-enabled tool row of every registered provider. */
export async function runScheduledConnectionSyncs(
  reason: SyncTriggerReason = "cron"
): Promise<
  Array<RunConnectionSyncResult & { toolId: string; error?: string }>
> {
  const results: Array<
    RunConnectionSyncResult & { toolId: string; error?: string }
  > = [];
  for (const provider of getSyncProviders()) {
    const rows = await db.query.tools.findMany({
      where: eq(tools.name, provider),
      columns: { id: true, workspaceId: true, metadata: true },
    });
    for (const row of rows) {
      if (!isProviderSyncEnabled(row.metadata)) continue;
      try {
        const res = await runConnectionSync({
          provider,
          toolId: row.id,
          workspaceId: row.workspaceId,
          reason,
        });
        results.push({ ...res, toolId: row.id });
      } catch (err) {
        // One tool row's failure must not starve the rest — but it is REPORTED.
        logger.error(
          { err, provider, toolId: row.id },
          "scheduled connection sync failed"
        );
        results.push({
          provider,
          toolId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return results;
}

// ── Enqueue and status ───────────────────────────────────────────────────────────

/**
 * What an enqueue did. `debounced` = pg-boss refused the job because this
 * provider + connection already had one (queued, running, or finished) inside
 * the debounce window — no new run was queued.
 */
export type EnqueueConnectionSyncResult =
  { queued: true; jobId: string } | { queued: false; reason: "debounced" };

/**
 * Enqueue a sync run. Duplicate triggers for the same provider + connection
 * inside the debounce window collapse into one job; a run already in flight is
 * guarded by the per-kind lease. Throws when the queue is unavailable.
 */
export async function enqueueConnectionSync(input: {
  provider: string;
  connectionId?: string;
  workspaceId?: string | null;
  reason: SyncTriggerReason;
}): Promise<EnqueueConnectionSyncResult> {
  const boss = getBoss();
  // Mark BEFORE the send: a job cannot start before its mark has landed, so a
  // fast run's terminal phase is never overwritten by a late `fetching`.
  const marked: QueuedMark[] = [];
  try {
    await markQueued(input, marked);
  } catch (err) {
    // The runner writes the real phase; a failed mark must not stop the enqueue.
    logger.error(
      { err, provider: input.provider, connectionId: input.connectionId },
      "connection sync: queued-phase mark failed"
    );
  }
  let jobId: string | null;
  try {
    jobId = await boss.send(
      CONNECTION_SYNC_QUEUE,
      {
        provider: input.provider,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        ...(input.workspaceId !== undefined
          ? { workspaceId: input.workspaceId }
          : {}),
        reason: input.reason,
      },
      {
        singletonKey: `${input.provider}:${input.connectionId ?? input.workspaceId ?? "pod"}`,
        singletonSeconds: ENQUEUE_DEBOUNCE_SECONDS,
      }
    );
  } catch (err) {
    await restoreQueued(input.provider, marked);
    throw err;
  }
  // null = the window already holds a job (queued, running or finished): no run
  // was queued for this mark, so each kind gets back the phase it had.
  if (!jobId) {
    await restoreQueued(input.provider, marked);
    return { queued: false, reason: "debounced" };
  }
  return { queued: true, jobId };
}

/** A kind's state before the queued mark — what a send that queued nothing restores. */
interface QueuedMark {
  key: KindStateKey;
  phase: SyncPhase | null;
  error: string | null;
  lastRunAt: string | null;
}

/**
 * Give each marked kind back its previous phase and error. A kind a run has
 * touched since the mark (phase moved, a new `lastRunAt`, or a held lease) keeps
 * what that run wrote. Failures are logged: the enqueue outcome stands.
 */
async function restoreQueued(
  provider: string,
  marked: QueuedMark[]
): Promise<void> {
  if (marked.length === 0) return;
  try {
    const tool = await resolveSyncTool({
      provider,
      toolId: marked[0]!.key.toolId,
    });
    for (const m of marked) {
      const now = readKindState(tool?.metadata, m.key.kind, m.key.connectionId);
      const leased =
        !!now.leaseUntil && Date.parse(now.leaseUntil) > Date.now();
      if (
        now.phase !== "fetching" ||
        (now.lastRunAt ?? null) !== m.lastRunAt ||
        leased
      ) {
        continue;
      }
      await patchKindState(m.key, { phase: m.phase, error: m.error });
    }
  } catch (err) {
    logger.error(
      { err, provider },
      "connection sync: restoring the pre-enqueue phase failed"
    );
  }
}

/**
 * Persist `fetching` for each enabled kind × connection the job will run, in
 * the runner's own state store, so a status read right after connect shows the
 * run instead of a null phase. A kind held on a PENDING review keeps
 * `review_ready`: the runner reads it to skip, and overwriting it would re-file.
 * Each kind's prior state is pushed to `marked` before it is overwritten.
 */
async function markQueued(
  input: {
    provider: string;
    connectionId?: string;
    workspaceId?: string | null;
  },
  marked: QueuedMark[]
): Promise<void> {
  const tool = await resolveSyncTool(input);
  const syncCfg = (tool?.metadata as ProviderToolMetadata | null | undefined)
    ?.sync;
  if (!tool || syncCfg?.enabled !== true) return;
  const connections = await resolveSyncConnections(
    tool.id,
    input.connectionId ?? syncCfg.connectionId
  );
  for (const conn of connections) {
    for (const handler of getSyncKinds(input.provider)) {
      if (!resolveKindConfig(handler, syncCfg).enabled) continue;
      const state = readKindState(tool.metadata, handler.kind, conn.id);
      if (
        state.phase === "review_ready" &&
        state.proposalId &&
        (await proposalStatus(state.proposalId)) === ProposalStatus.PENDING
      ) {
        continue;
      }
      const key = {
        toolId: tool.id,
        kind: handler.kind,
        connectionId: conn.id,
      };
      marked.push({
        key,
        phase: state.phase ?? null,
        error: state.error ?? null,
        lastRunAt: state.lastRunAt ?? null,
      });
      await patchKindState(key, { phase: "fetching", error: null });
    }
  }
}

/** Wire shape of a sync-status row; every door derives its response from it. */
export const ConnectionSyncStatusSchema = z.object({
  provider: z.string(),
  connectionId: z.string().optional(),
  /**
   * The tool row's workspace — the scope this connection's runs resolve their
   * rule under and file proposals in (null = pod-wide).
   */
  workspaceId: z.string().nullable(),
  kind: z.string(),
  enabled: z.boolean(),
  /** Profile slugs this kind writes. */
  profileSlugs: z.array(z.string()),
  /** Slugs whose entities carry a source-app url ("open where it lives"). */
  openableProfileSlugs: z.array(z.string()),
  lastRunAt: z.string().optional(),
  // `SyncPhase`, as literals (zod-openapi needs them). "not_connected" = sync
  // is on but no live connection backs it; `failed` = a run started and errored.
  phase: z
    .enum([
      "fetching",
      "mapping",
      "review_ready",
      "synced",
      "failed",
      "not_connected",
    ])
    .optional(),
  counts: z
    .object({
      fetched: z.number(),
      created: z.number(),
      merged: z.number(),
      skipped: z.number(),
      /** Per-profile created/merged breakdown; absent on older state. */
      byProfile: z
        .record(
          z.string(),
          z.object({ created: z.number(), merged: z.number() })
        )
        .optional(),
    })
    .optional(),
  proposalId: z.string().optional(),
  /**
   * "Keep syncing automatically", on every row. `available` = the connection
   * has an approved first import (the predicate `setKeepSyncing` uses).
   */
  keepSyncing: z.object({
    enabled: z.boolean(),
    ruleId: z.string().optional(),
    available: z.boolean(),
  }),
  error: z.string().optional(),
});

export type ConnectionSyncStatus = z.infer<
  typeof ConnectionSyncStatusSchema
> & {
  phase?: SyncPhase;
  counts?: SyncCounts;
};

// Compile-time equality with `SyncPhase`, in both directions.
type SchemaPhase = NonNullable<
  z.infer<typeof ConnectionSyncStatusSchema>["phase"]
>;
type _PhaseParity = [SchemaPhase] extends [SyncPhase]
  ? [SyncPhase] extends [SchemaPhase]
    ? true
    : never
  : never;
const _phaseParity: _PhaseParity = true;
void _phaseParity;

/** A status row before `keepSyncing` is computed. */
export type ConnectionSyncStatusDraft = Omit<
  ConnectionSyncStatus,
  "keepSyncing"
>;

/**
 * Sync status per provider tool × kind × connection, read from the stored state.
 * `workspaceId` undefined = every row; null = pod-wide rows only.
 */
export async function getConnectionSyncStatus(input: {
  provider?: string;
  workspaceId?: string | null;
  /** Only rows this user may see: their own connections, plus rows naming none. */
  userId?: string;
}): Promise<ConnectionSyncStatus[]> {
  const providers = input.provider ? [input.provider] : getSyncProviders();
  if (providers.length === 0) return [];
  const rows = await db.query.tools.findMany({
    where: and(
      inArray(tools.name, providers),
      input.workspaceId === null
        ? isNull(tools.workspaceId)
        : input.workspaceId
          ? eq(tools.workspaceId, input.workspaceId)
          : undefined
    ),
    columns: { id: true, name: true, workspaceId: true, metadata: true },
  });

  // Rows gain `keepSyncing` in `withKeepSyncing`, after the user filter.
  const out: ConnectionSyncStatusDraft[] = [];
  /** Live connection id → its owner. */
  const liveOwner = new Map<string, string>();
  for (const row of rows) {
    const syncCfg = (row.metadata as ProviderToolMetadata | null)?.sync;
    // Live connections behind a sync-enabled row — a row with sync ON and none
    // is reported per kind as `not_connected` (a connect prompt, not a failed
    // run), never silently absent.
    const live =
      syncCfg?.enabled === true
        ? await resolveSyncConnections(row.id, syncCfg.connectionId)
        : [];
    for (const c of live) liveOwner.set(c.id, c.userId);
    for (const handler of getSyncKinds(row.name)) {
      const cfg = resolveKindConfig(handler, syncCfg);
      const base = {
        provider: row.name,
        workspaceId: row.workspaceId ?? null,
        kind: handler.kind,
        enabled: syncCfg?.enabled === true && cfg.enabled,
        profileSlugs: handler.profileSlugs,
        openableProfileSlugs: handler.openableProfileSlugs,
      };
      if (syncCfg?.enabled === true && live.length === 0) {
        out.push({ ...base, phase: "not_connected" });
        continue;
      }
      const states = syncCfg?.kinds?.[handler.kind]?.connections ?? {};
      const connectionIds = new Set([
        ...live.map((c) => c.id),
        ...Object.keys(states),
      ]);
      if (connectionIds.size === 0) {
        out.push(base);
        continue;
      }
      for (const connectionId of connectionIds) {
        const state: KindSyncState = states[connectionId] ?? {};
        out.push({
          ...base,
          connectionId,
          ...(state.lastRunAt ? { lastRunAt: state.lastRunAt } : {}),
          ...(state.phase ? { phase: state.phase } : {}),
          ...(state.counts ? { counts: state.counts } : {}),
          ...(state.proposalId ? { proposalId: state.proposalId } : {}),
          ...(state.error ? { error: state.error } : {}),
        });
      }
    }
  }
  const visible = input.userId
    ? scopeSyncStatusToUser(out, await readOwnedConnectionIds(input.userId))
    : out;
  return withKeepSyncing(visible, liveOwner);
}

type KeepSyncing = { enabled: boolean; ruleId?: string; available: boolean };

/**
 * "Keep syncing automatically", computed once here so no client re-derives the
 * rule precedence: the connection rule exactly as a steady run resolves it,
 * under the row's own workspace (one rule read per connection × scope).
 * `available` = the switch may turn on — the connection has an approved first
 * import (one lookup per connection). A row naming no live connection has
 * nothing that would sync, so it is off and unavailable.
 */
async function withKeepSyncing(
  rows: ConnectionSyncStatusDraft[],
  liveOwner: ReadonlyMap<string, string>
): Promise<ConnectionSyncStatus[]> {
  const decisions = new Map<string, Promise<Omit<KeepSyncing, "available">>>();
  const approvals = new Map<string, Promise<boolean>>();
  return Promise.all(
    rows.map(async (row) => {
      const owner = row.connectionId
        ? liveOwner.get(row.connectionId)
        : undefined;
      if (!row.connectionId || !owner) {
        const off: KeepSyncing = { enabled: false, available: false };
        return { ...row, keepSyncing: off };
      }
      const key = `${row.workspaceId ?? ""}|${row.connectionId}`;
      let decision = decisions.get(key);
      if (!decision) {
        decision = resolveConnectionSyncDecision({
          userId: owner,
          workspaceId: row.workspaceId,
          connectionId: row.connectionId,
        }).then((d) => ({
          enabled: d.verdict === "auto",
          ...(d.ruleId ? { ruleId: d.ruleId } : {}),
        }));
        decisions.set(key, decision);
      }
      let available = approvals.get(row.connectionId);
      if (!available) {
        available = findApprovedConnectionImport(row.connectionId).then(
          (approved) => approved !== null
        );
        approvals.set(row.connectionId, available);
      }
      const keepSyncing: KeepSyncing = {
        ...(await decision),
        available: await available,
      };
      return { ...row, keepSyncing };
    })
  );
}
