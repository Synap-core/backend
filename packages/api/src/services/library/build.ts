/**
 * Library BUILD — one Library group (or one item, "Read now") → one governed
 * bundle, through THE shared Build core (`buildImportMembers`).
 *
 *   - `buildLibraryGroup`: CLAIMS the group (`library_groups.building_at`,
 *     under a row lock — a double tap or a second device is refused), reads its
 *     kept, unarchived members — on a REBUILD only the items staged after
 *     `built_at` — and files the bundle in the newest member's run (the run is
 *     the unit of undo). On success the group records `built_at` and appends
 *     the bundle's proposal id to `build_proposal_ids`; each item read records
 *     `importCuration.builtAt`. A refusal or a failure releases the claim.
 *     Update mode (reusing `container_entity_id`, `update_*` ops for what the
 *     group made before) is the core's to add — the group row carries what it
 *     needs.
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
import { loadImportSession } from "../imports/session.js";
import { toItemView, type ImportItemRow } from "../imports/read-model.js";
import { asImportGroup, loadLibraryGroup } from "./groups.js";
import {
  inGroupSql,
  isArchivedSql,
  libraryItemsWhere,
  loadLibraryItemRows,
  selectLibraryItemRows,
  type LibraryDb,
  type LibraryItemRow,
} from "./read-model.js";

const logger = createLogger({ module: "library/build" });

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

/** The members Build reads, each steered by THIS group's note only. */
function asMembers(rows: readonly LibraryItemRow[], group: ImportGroup) {
  return rows.flatMap((row) => {
    const view = toItemView(row);
    return view
      ? [
          {
            row: row as unknown as ImportItemRow,
            view: { ...view, groupKeys: [group.key] },
          },
        ]
      : [];
  });
}

async function markItemsBuiltAt(
  database: LibraryDb,
  userId: string,
  ids: readonly string[],
  at: string
) {
  if (ids.length === 0) return;
  await database
    .update(documents)
    .set({
      metadata: drizzleSql`jsonb_set(${documents.metadata}, '{importCuration,builtAt}', ${JSON.stringify(at)}::jsonb, true)`,
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
        groupRow.builtAt
          ? drizzleSql`${documents.createdAt} > ${groupRow.builtAt.toISOString()}::timestamptz`
          : undefined
      )!,
      order: "oldest",
    });
    if (rows.length === 0) {
      return refused(groupRow.builtAt ? "nothing_new" : "nothing_to_build");
    }
    // The newest member's run: still the person's, and the unit of undo.
    const runId = runOf(rows[rows.length - 1]!);
    if (!runId) return refused("no_run");
    const run = await loadImportSession({
      database,
      userId: args.userId,
      sessionId: runId,
    });
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
    if (built.result.status === "refused") return built.result;
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
      at.toISOString()
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
  const run = await loadImportSession({
    database,
    userId: args.userId,
    sessionId: runId,
  });
  const view = toItemView(row);
  if (!view) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
  }
  const group: ImportGroup = {
    key: "read-now",
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
        row: row as unknown as ImportItemRow,
        view: { ...view, decision: "keep", groupKeys: [group.key] },
      },
    ],
    deps: args.depsFor({ workspaceId }),
    withoutContainer: true,
  });
  if (built.result.status !== "refused") {
    await markItemsBuiltAt(
      database,
      args.userId,
      built.builtIds,
      new Date().toISOString()
    );
  }
  return built.result;
}
