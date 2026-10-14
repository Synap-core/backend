/**
 * Library BUILD — one Library group (or one item, "Read now") → one governed
 * bundle, through THE shared Build core (`buildImportMembers`).
 *
 *   - `buildLibraryGroup`: CLAIMS the group (`library_groups.building_at`,
 *     under a row lock — a double tap or a second device is refused), reads its
 *     kept, unarchived members — on a REBUILD only the items staged after
 *     items still WAITING in the group (`waitingInGroupSql`) — and files the
 *     bundle in the newest member's open run (the run is the unit of undo;
 *     today's run when that one closed). On success the group records
 *     `built_at` and appends the bundle's proposal id to `build_proposal_ids`;
 *     each item read records `importCuration.builtBy[group]`. A refusal or a
 *     failure releases the claim. A group built before is rebuilt in UPDATE
 *     mode (`rebuild`: its container reused, `update_*` ops for what its
 *     earlier bundles made), refused while the last bundle waits for review.
 *   - `readNowLibraryItem`: the explicit "Read now" — the item alone, no group
 *     container.
 *
 * Owner-floored throughout; `proposed` is success.
 */

import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import {
  db as defaultDb,
  documents,
  libraryGroups,
  and,
  eq,
  inArray,
  drizzleSql,
  type LibraryGroupRow,
} from "@synap/database";
import type { ImportBuildResult, ImportGroup } from "@synap-core/types/imports";
import {
  buildImportMembers,
  resolvePriorBuild,
  BUILD_CLAIM_TTL_MS,
  type ImportBuildDeps,
} from "../imports/build.js";
import {
  loadImportSession,
  type ImportSessionRow,
} from "../imports/session.js";
import { ensureLibraryRun } from "./add.js";
import { toItemView, type ImportItemRow } from "../imports/read-model.js";
import {
  asImportGroup,
  loadLibraryGroup,
  pendingBuildProposalIds,
} from "./groups.js";
import {
  inGroupSql,
  isArchivedSql,
  builtForGroupSql,
  libraryItemsWhere,
  loadLibraryItemRows,
  readLibraryCuration,
  LIBRARY_BUILT_WITHOUT_PROPOSAL,
  selectLibraryItemRows,
  type LibraryDb,
  type LibraryItemRow,
} from "./read-model.js";

const logger = createLogger({ module: "library/build" });

/** The `builtBy` key (and synthetic group key) of a Read now bundle. */
const READ_NOW_BUILD_KEY = "read-now";

const refused = (reason: string): ImportBuildResult => ({
  status: "refused",
  reason,
  read: 0,
  skipped: [],
});

/** The run an item was staged in (its `intakeSource.sessionId`). */
function runOf(row: { metadata: unknown }): string | null {
  const id = (
    (row.metadata as Record<string, unknown> | null)?.intakeSource as
      { sessionId?: string | null } | undefined
  )?.sessionId;
  return typeof id === "string" ? id : null;
}

/** A Library row as the Build core reads it (its metadata is an object bag). */
function asImportItemRow(row: LibraryItemRow): ImportItemRow {
  return {
    id: row.id,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
  };
}

/** The members Build reads, each steered by THIS group's note only. */
function asMembers(rows: readonly LibraryItemRow[], group: ImportGroup) {
  return rows.flatMap((row) => {
    const view = toItemView(row);
    return view
      ? [
          {
            row: asImportItemRow(row),
            view: { ...view, groupKeys: [group.key] },
          },
        ]
      : [];
  });
}

/**
 * Stamp the items a Build READ: `builtAt` (display) and, for a group build,
 * `builtBy[groupId]` = the bundle that read them (or "applied" when none was
 * filed). "Built for this group" is derived from that bundle's status
 * (`builtForGroupSql`), so a rejected / reverted bundle unbuilds them.
 */
async function markItemsBuiltAt(
  database: LibraryDb,
  userId: string,
  ids: readonly string[],
  at: string,
  forGroup: { groupId: string; proposalId?: string },
  /** The person asked for it (Read now): the auto-archive clock restarts. */
  seen = false
) {
  if (ids.length === 0) return;
  const stamped = drizzleSql`jsonb_set(${documents.metadata}, '{importCuration,builtAt}', ${JSON.stringify(at)}::jsonb, true)`;
  const withSeen = seen
    ? drizzleSql`jsonb_set(${stamped}, '{importCuration,seenAt}', ${JSON.stringify(at)}::jsonb, true)`
    : stamped;
  await database
    .update(documents)
    .set({
      metadata: drizzleSql`jsonb_set(${withSeen}, '{importCuration,builtBy}', COALESCE(${documents.metadata} -> 'importCuration' -> 'builtBy', '{}'::jsonb) || ${JSON.stringify({ [forGroup.groupId]: forGroup.proposalId ?? LIBRARY_BUILT_WITHOUT_PROPOSAL })}::jsonb, true)`,
    })
    .where(
      and(
        libraryItemsWhere(userId),
        inArray(documents.id, [...ids]),
        drizzleSql`${documents.metadata} ? 'importCuration'`
      )
    );
}

async function claimLibraryGroup(
  database: LibraryDb,
  userId: string,
  groupId: string
): Promise<{ group: LibraryGroupRow } | { refused: ImportBuildResult }> {
  return database.transaction(async (tx) => {
    const t = tx as unknown as LibraryDb;
    const group = await loadLibraryGroup({
      database: t,
      userId,
      groupId,
      forUpdate: true,
    });
    if (group.archivedAt) return { refused: refused("archived") };
    if (
      group.buildingAt &&
      Date.now() - group.buildingAt.getTime() < BUILD_CLAIM_TTL_MS
    ) {
      return { refused: refused("already_building") };
    }
    const [claimed] = await t
      .update(libraryGroups)
      .set({ buildingAt: new Date() })
      .where(
        and(eq(libraryGroups.id, groupId), eq(libraryGroups.userId, userId))
      )
      .returning();
    return { group: claimed! };
  });
}

async function releaseLibraryGroup(
  database: LibraryDb,
  userId: string,
  groupId: string
) {
  await database
    .update(libraryGroups)
    .set({ buildingAt: null })
    .where(
      and(eq(libraryGroups.id, groupId), eq(libraryGroups.userId, userId))
    );
}

/**
 * The run a Build files in — the unit of undo. The item's own run while it is
 * open; once it closed (a Library run is closed after its day), today's open
 * Library run in the same lens (`ensureLibraryRun`, which re-checks the
 * space's write gate).
 */
async function openRunFor(
  database: LibraryDb,
  userId: string,
  runId: string
): Promise<ImportSessionRow> {
  const run = await loadImportSession({ database, userId, sessionId: runId });
  if (run.status === "active") return run;
  return ensureLibraryRun({
    database,
    userId,
    device: null,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    incoming: 0,
  });
}

/** `library.build` — first build, or a rebuild over the items new since built. */
export async function buildLibraryGroup(args: {
  database?: LibraryDb;
  userId: string;
  groupId: string;
  /** Deps for the run the build files in (workspace-scoped by the caller). */
  depsFor: (run: { workspaceId: string | null }) => ImportBuildDeps;
}): Promise<ImportBuildResult> {
  const database = args.database ?? defaultDb;
  const claim = await claimLibraryGroup(database, args.userId, args.groupId);
  if ("refused" in claim) return claim.refused;
  const groupRow = claim.group;
  let landed = false;
  try {
    const rows = await selectLibraryItemRows({
      database,
      where: and(
        libraryItemsWhere(args.userId),
        inGroupSql(groupRow.id),
        drizzleSql`NOT ${isArchivedSql}`,
        // Not read by a Build that still counts — per item, per group, from
        // the bundle's status (an old item that joined later, a rejected
        // bundle's items, one added mid-build: all unbuilt here).
        drizzleSql`NOT ${builtForGroupSql(drizzleSql`${documents.metadata}`, drizzleSql`${groupRow.id}::text`)}`
      )!,
      order: "oldest",
    });
    const keptRows = rows.filter(
      (r) => readLibraryCuration(r.metadata).decision === "keep"
    );
    if (keptRows.length === 0) {
      return refused(groupRow.builtAt ? "nothing_new" : "nothing_to_build");
    }
    // The newest member's run: still the person's, and the unit of undo.
    const runId = runOf(rows[rows.length - 1]!);
    if (!runId) return refused("no_run");
    const run = await openRunFor(database, args.userId, runId);
    const group = asImportGroup(groupRow);
    const workspaceId = groupRow.workspaceId ?? run.workspaceId;
    const priorProposalIds = Array.isArray(groupRow.buildProposalIds)
      ? groupRow.buildProposalIds.filter(
          (id): id is string => typeof id === "string"
        )
      : [];
    const built = await buildImportMembers({
      database,
      userId: args.userId,
      session: { id: run.id, workspaceId, projectId: run.projectId },
      group,
      groups: [group],
      members: asMembers(rows, group),
      deps: args.depsFor({ workspaceId }),
      // UPDATE MODE: a group built before updates what its earlier bundles
      // made and reuses its container — never a twin.
      ...(priorProposalIds.length > 0 || groupRow.builtAt
        ? {
            rebuild: {
              proposalIds: priorProposalIds,
              containerEntityId: groupRow.containerEntityId,
            },
          }
        : {}),
    });
    if (built.result.status === "refused") {
      if (built.result.reason === "previous_build_pending") {
        // Name the bundle that waits, so the client can open its review.
        const waiting = await pendingBuildProposalIds(database, [
          { groupId: groupRow.id, proposalIds: priorProposalIds },
        ]);
        const id = waiting.get(groupRow.id);
        if (id) return { ...built.result, proposalId: id };
      }
      return built.result;
    }
    const at = new Date();
    // The container, once it is a real row: reused by this rebuild, or made
    // by a bundle that applied at once. A first bundle still pending has only
    // a ref; the NEXT build resolves it from that bundle's stamped
    // `materialized.byOp` (`resolvePriorBuild`) and records it here.
    let containerEntityId = built.containerEntityId;
    if (
      !containerEntityId &&
      built.result.status === "applied" &&
      built.result.proposalId
    ) {
      containerEntityId = (
        await resolvePriorBuild({
          database,
          userId: args.userId,
          proposalIds: [built.result.proposalId],
        })
      ).prior.containerEntityId;
    }
    await markItemsBuiltAt(
      database,
      args.userId,
      built.builtIds,
      at.toISOString(),
      {
        groupId: groupRow.id,
        ...(built.result.proposalId
          ? { proposalId: built.result.proposalId }
          : {}),
      }
    );
    await database
      .update(libraryGroups)
      .set({
        buildingAt: null,
        builtAt: at,
        updatedAt: at,
        ...(containerEntityId ? { containerEntityId } : {}),
        ...(built.result.proposalId
          ? {
              buildProposalIds: drizzleSql`(CASE WHEN jsonb_typeof(${libraryGroups.buildProposalIds}) = 'array' THEN ${libraryGroups.buildProposalIds} ELSE '[]'::jsonb END) || ${JSON.stringify([built.result.proposalId])}::jsonb`,
            }
          : {}),
      })
      .where(
        and(
          eq(libraryGroups.id, groupRow.id),
          eq(libraryGroups.userId, args.userId)
        )
      );
    landed = true;
    return built.result;
  } finally {
    if (!landed) {
      await releaseLibraryGroup(database, args.userId, groupRow.id).catch(
        (err) =>
          // The claim expires after BUILD_CLAIM_TTL_MS; said, not hidden.
          logger.error(
            { err, groupId: groupRow.id },
            "library build: claim NOT released — the group stays locked until it expires"
          )
      );
    }
  }
}

/** `library.readNow` — one item, structured now, filed alone. */
export async function readNowLibraryItem(args: {
  database?: LibraryDb;
  userId: string;
  itemId: string;
  depsFor: (run: { workspaceId: string | null }) => ImportBuildDeps;
}): Promise<ImportBuildResult> {
  const database = args.database ?? defaultDb;
  const [row] = await loadLibraryItemRows({
    database,
    userId: args.userId,
    ids: [args.itemId],
  });
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
  }
  const runId = runOf(row);
  if (!runId) return refused("no_run");
  const run = await openRunFor(database, args.userId, runId);
  const view = toItemView(row);
  if (!view) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
  }
  const group: ImportGroup = {
    key: READ_NOW_BUILD_KEY,
    name: view.title,
    origin: "user",
    outputs: ["things"],
  };
  const workspaceId = run.workspaceId;
  const built = await buildImportMembers({
    database,
    userId: args.userId,
    session: { id: run.id, workspaceId, projectId: run.projectId },
    group,
    groups: [group],
    // Read now is the person's explicit choice: it reads even a "later" item.
    members: [
      {
        row: asImportItemRow(row),
        view: { ...view, decision: "keep", groupKeys: [group.key] },
      },
    ],
    deps: args.depsFor({ workspaceId }),
    withoutContainer: true,
  });
  if (built.result.status !== "refused") {
    // Read now's bundle cites the item too (`builtBy["read-now"]`): it cannot
    // be deleted from under it, and a rejected Read now leaves it uncited.
    await markItemsBuiltAt(
      database,
      args.userId,
      built.builtIds,
      new Date().toISOString(),
      {
        groupId: READ_NOW_BUILD_KEY,
        ...(built.result.proposalId
          ? { proposalId: built.result.proposalId }
          : {}),
      },
      true
    );
  }
  return built.result;
}
