/**
 * Connection-sync persistence — where the runner reads WHICH tool row and
 * connections a run covers, and writes its per-connection state.
 *
 * State lives on the provider tool row at
 * `metadata.sync.kinds.<kind>.connections.<connectionId>`, written through ONE
 * jsonb path expression that creates missing parents and merges the patch over
 * the existing leaf — so config keys the template/user own beside it
 * (`enabled`, `windowDays`, …) are never rewritten by a run.
 */

import {
  db,
  tools,
  secrets,
  links,
  proposals,
  eq,
  and,
  isNull,
  isNotNull,
  desc,
  drizzleSql,
} from "@synap/database";
import { resolveTool } from "../tools/resolve-tool.js";
import type { SyncCounts, SyncPhase } from "./sync-kind-registry.js";

const LEASE_MS = 15 * 60_000;

/** Per-connection run state for one kind. */
export interface KindSyncState {
  /** ISO start of the last COMPLETED run — the next steady run's `since`. */
  cursor?: string | null;
  /** ISO start of the run in progress (kept for a resumed page). */
  runStartedAt?: string | null;
  /** Next page of an interrupted steady run; null when none is pending. */
  pageToken?: string | null;
  phase?: SyncPhase;
  lastRunAt?: string;
  counts?: SyncCounts;
  proposalId?: string | null;
  error?: string | null;
  leaseUntil?: string | null;
}

export interface KindStateKey {
  toolId: string;
  kind: string;
  connectionId: string;
}

/**
 * The `isEnabled` predicate for `resolveTool(provider, …)`: an unscoped resolve
 * prefers the row whose sync is actually switched on.
 */
export function isProviderSyncEnabled(metadata: unknown): boolean {
  return (metadata as { sync?: { enabled?: boolean } })?.sync?.enabled === true;
}

export function readKindState(
  metadata: unknown,
  kind: string,
  connectionId: string
): KindSyncState {
  const sync = (
    metadata as {
      sync?: {
        kinds?: Record<string, { connections?: Record<string, KindSyncState> }>;
      };
    } | null
  )?.sync;
  return sync?.kinds?.[kind]?.connections?.[connectionId] ?? {};
}

function withKindState(
  kind: string,
  connectionId: string,
  patch: KindSyncState
) {
  const m = tools.metadata;
  return drizzleSql`jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(COALESCE(${m}, '{}'::jsonb), '{sync}', COALESCE(${m}#>'{sync}', '{}'::jsonb), true),
          '{sync,kinds}', COALESCE(${m}#>'{sync,kinds}', '{}'::jsonb), true),
        ARRAY['sync','kinds',${kind}]::text[],
        COALESCE(${m}#>ARRAY['sync','kinds',${kind}]::text[], '{}'::jsonb), true),
      ARRAY['sync','kinds',${kind},'connections']::text[],
      COALESCE(${m}#>ARRAY['sync','kinds',${kind},'connections']::text[], '{}'::jsonb), true),
    ARRAY['sync','kinds',${kind},'connections',${connectionId}]::text[],
    COALESCE(${m}#>ARRAY['sync','kinds',${kind},'connections',${connectionId}]::text[], '{}'::jsonb)
      || ${JSON.stringify(patch)}::jsonb,
    true)`;
}

export async function patchKindState(
  key: KindStateKey,
  patch: KindSyncState
): Promise<void> {
  await db
    .update(tools)
    .set({ metadata: withKindState(key.kind, key.connectionId, patch) })
    .where(eq(tools.id, key.toolId));
}

/**
 * Atomic lease: returns the row's metadata when acquired, null while another
 * run holds it. An expired lease (a crashed run) is simply taken over.
 */
export async function acquireLease(key: KindStateKey): Promise<unknown | null> {
  const leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
  const rows = await db
    .update(tools)
    .set({
      metadata: withKindState(key.kind, key.connectionId, { leaseUntil }),
    })
    .where(
      and(
        eq(tools.id, key.toolId),
        drizzleSql`COALESCE((${tools.metadata}#>>ARRAY['sync','kinds',${key.kind},'connections',${key.connectionId},'leaseUntil']::text[])::timestamptz, 'epoch'::timestamptz) < now()`
      )
    )
    .returning({ metadata: tools.metadata });
  return rows.length > 0 ? (rows[0]!.metadata ?? {}) : null;
}

export interface SyncToolRow {
  id: string;
  createdBy: string;
  workspaceId: string | null;
  metadata: unknown;
}

/** The provider tool row a run covers: pinned row → a connection's tool → scoped resolve. */
export async function resolveSyncTool(opts: {
  provider: string;
  workspaceId?: string | null;
  connectionId?: string;
  toolId?: string;
}): Promise<SyncToolRow | null> {
  if (opts.toolId) {
    const row = await db.query.tools.findFirst({
      where: and(eq(tools.id, opts.toolId), eq(tools.name, opts.provider)),
      columns: { id: true, createdBy: true, workspaceId: true, metadata: true },
    });
    return row ?? null;
  }
  if (opts.connectionId) {
    // The connection names its capability; the capability's member tool of this
    // provider is the row that carries the sync config.
    const [row] = await db
      .select({
        id: tools.id,
        createdBy: tools.createdBy,
        workspaceId: tools.workspaceId,
        metadata: tools.metadata,
      })
      .from(secrets)
      .innerJoin(
        links,
        and(
          eq(links.toType, "capability"),
          eq(links.fromType, "tool"),
          eq(links.linkType, "member_of"),
          eq(links.toId, drizzleSql`${secrets.capabilityId}::text`)
        )
      )
      .innerJoin(tools, eq(drizzleSql`${tools.id}::text`, links.fromId))
      .where(
        and(
          eq(secrets.id, opts.connectionId),
          isNull(secrets.deletedAt),
          eq(tools.name, opts.provider)
        )
      )
      .limit(1);
    return row ?? null;
  }
  return resolveTool(opts.provider, isProviderSyncEnabled, opts.workspaceId);
}

/** The live connections (secrets rows) of the tool's capability. */
export async function resolveSyncConnections(
  toolId: string,
  pinnedConnectionId: string | undefined
): Promise<Array<{ id: string; userId: string }>> {
  const [edge] = await db
    .select({ capabilityId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "tool"),
        eq(links.fromId, toolId),
        eq(links.linkType, "member_of"),
        eq(links.toType, "capability")
      )
    )
    .limit(1);
  if (!edge) return [];
  return db
    .select({ id: secrets.id, userId: secrets.userId })
    .from(secrets)
    .where(
      and(
        eq(drizzleSql`${secrets.capabilityId}::text`, edge.capabilityId),
        isNotNull(secrets.accountHint),
        isNull(secrets.deletedAt),
        drizzleSql`COALESCE(${secrets.connectionState}, 'connected') <> 'disconnected'`,
        ...(pinnedConnectionId ? [eq(secrets.id, pinnedConnectionId)] : [])
      )
    );
}

/**
 * The connection registry rows a user owns — the ownership rule for sync status
 * (a per-connection row carries that connection's error, proposal and counts).
 */
export async function readOwnedConnectionIds(
  userId: string
): Promise<Set<string>> {
  const rows = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(
        eq(secrets.userId, userId),
        isNotNull(secrets.capabilityId),
        isNull(secrets.deletedAt)
      )
    );
  return new Set(rows.map((r) => r.id));
}

/**
 * The connection's most recently approved first import — the consent automatic
 * syncing is earned from. Null until one is approved. The keep-syncing toggle
 * and the status row's `keepSyncing.available` both read this, so they cannot
 * disagree about when the switch may turn on.
 */
export async function findApprovedConnectionImport(
  connectionId: string
): Promise<{ id: string } | null> {
  const [approved] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        eq(proposals.proposalType, "import.graph"),
        eq(proposals.status, "approved"),
        drizzleSql`${proposals.data} -> 'connectionSync' ->> 'connectionId' = ${connectionId}`
      )
    )
    .orderBy(
      drizzleSql`${proposals.reviewedAt} desc nulls last`,
      desc(proposals.updatedAt)
    )
    .limit(1);
  return approved ?? null;
}

/** A proposal's status; null when the row does not exist. */
export async function proposalStatus(
  proposalId: string
): Promise<string | null> {
  const [row] = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .limit(1);
  return row?.status ?? null;
}
