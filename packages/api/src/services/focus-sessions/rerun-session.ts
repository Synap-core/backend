/**
 * RERUN A RUN — a NEW session `spawned_from` the previous one (intake plan,
 * locked founder decision 2).
 *
 *   replace — revert everything the parent applied FIRST (the one session
 *             revert door, `revertSession`), then structure again.
 *   add     — structure again on top; the parent's work stays.
 *
 * Re-analyses from the STORED sources (`metadata.run.sourceDocumentIds`, the
 * documents `stageIntakeSource` kept — degraded ones included) through the SAME
 * intake doors a first run takes: `capture.structure` → `submitCaptureGraph` for
 * text / url / file sources, `ImportOrchestrator.analyze` for import items. Those
 * doors read the CURRENT guidelines (`assembleStructureContext`) and write the
 * child's own manifest, so the child records the versions it actually used.
 *
 * ── Order, and why ──────────────────────────────────────────────────────────
 *   1. load the parent + the source ROWS (metadata only — no bodies)
 *   2. dryRun → counts + cap verdict + availability, nothing written or read
 *   3. refuse (not available / over cap / human-only replace / no sources)
 *   4. mint the child under a row lock on the parent (lineage + a NEW idempotency
 *      namespace) BEFORE reverting: a replace that reverted the parent and then
 *      failed to mint would leave the user with neither run.
 *   5. load the source BODIES — only now, after every refusal passed
 *   6. replace → revert the parent; every outcome that is not a clean revert is
 *      LISTED. A revert that did not run at all stops the rerun (no replay on
 *      top of a parent that was meant to be undone first).
 *   7. replay each source (imports grouped by adapter); every item gets an
 *      outcome, never a swallowed error.
 *
 * ── Availability (who may press Rerun) ──────────────────────────────────────
 * `assessRerunAvailability` is THE rule, used by this door AND projected on the
 * session read (`focusSessions.get` → `rerun`), so a surface never re-derives
 * it. An intake session is never closed (closing would expire its ephemeral
 * proposals), so "terminal" alone would refuse every intake rerun: a session
 * with stored sources is rerunnable when it is terminal OR has no in-flight work
 * (`listSessionBoundJobs` / `listRunningSessionTurns` — the same reads the
 * cancel door stops). A failed in-flight read is `availability_unknown`, never
 * "available".
 *
 * ── Idempotency ────────────────────────────────────────────────────────────
 * Each rerun session owns `rerun:<childSessionId>`. A capture replay files its
 * graph under `rerun:<child>:<sourceDocumentId>`; an import replay folds the
 * namespace into the import content key. A retry inside the same rerun dedups;
 * the parent's identical graph is never handed back.
 *
 * ── Governance ─────────────────────────────────────────────────────────────
 * The rerun itself files nothing directly: every write goes through the
 * governed capture/import doors on its own proposal. `replace` reverts approved
 * work, which is a HUMAN decision — an agent's replace is refused here, the
 * same rule as the session revert doors.
 */

import {
  db,
  and,
  eq,
  inArray,
  desc,
  isNull,
  proposals,
  focusSessions,
  documents as documentsTable,
  documentVersions,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { createHash } from "crypto";
import { createLogger } from "@synap-core/core";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import type { Context } from "../../types/context.js";
import { isTerminalSessionStatus } from "./session-statuses.js";
import {
  revertSession,
  type SessionProposalRevertOutcome,
} from "./revert-session.js";
import {
  listSessionBoundJobs,
  listRunningSessionTurns,
} from "./cancel-session.js";
import {
  ensureIntakeSession,
  INTAKE_SESSION_METADATA_KEY,
} from "../intake/ensure-intake-session.js";
import {
  readSessionRunManifest,
  recordSessionRunManifest,
} from "../intake/record-session-run-manifest.js";
import {
  INTAKE_SOURCE_METADATA_KEY,
  type IntakeSourceMetadata,
} from "../intake/stage-intake-source.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";

const logger = createLogger({ module: "rerun-session" });

/** No unbounded replay: a rerun re-structures at most this many sources. */
export const RERUN_MAX_SOURCES = 25;
/** `capture.structure` text cap; a longer body is replayed as a text file. */
export const STRUCTURE_TEXT_MAX = 8000;
/** `capture.structure` html cap. */
const STRUCTURE_HTML_MAX = 50_000;

export type RerunMode = "replace" | "add";

/** One stored source, loaded back into what its intake door takes. */
export type RerunSource =
  | {
      sourceDocumentId: string;
      door: "capture";
      kind: "text" | "url" | "file";
      degraded: boolean;
      input: {
        text?: string;
        url?: string;
        html?: string;
        file?: {
          content: string;
          mimeType: string;
          filename?: string;
          encoding: "base64" | "utf8";
        };
      };
    }
  | {
      sourceDocumentId: string;
      door: "import";
      kind: "import_item";
      degraded: boolean;
      item: { path: string; content: string };
    };

export type RerunItemOutcome =
  | "proposed"
  | "applied"
  | "deduplicated"
  | "not_structured"
  | "needs_input"
  | "failed";

export interface RerunItemResult {
  sourceDocumentIds: string[];
  door: "capture" | "import";
  outcome: RerunItemOutcome;
  proposalId?: string;
  reviewUrl?: string;
  reason?: string;
}

export interface RerunPlan {
  sources: {
    selected: number;
    capture: number;
    import: number;
    degraded: number;
    /** In the manifest, but the document is gone (deleted / not the owner's). */
    missing: string[];
    /** Asked for in `scope`, but not a source of this run. */
    notInRun: string[];
  };
  /** Applied proposals `replace` would revert (0 for `add`). */
  replaceWouldRevert: number;
  /** Still-pending proposals of the parent — `replace` withdraws them. */
  parentPending: number;
  /** One structure call per capture source; one per import item. */
  estimatedStructureCalls: number;
  cap: { max: number; withinCap: boolean };
}

export interface RerunReplayArgs {
  childSessionId: string;
  idempotencyNamespace: string;
  workspaceId: string | null;
  projectId: string | null;
}

export interface RerunReplayers {
  capture: (
    source: Extract<RerunSource, { door: "capture" }>,
    args: RerunReplayArgs
  ) => Promise<Omit<RerunItemResult, "sourceDocumentIds" | "door">>;
  /** Called once per import ADAPTER group — every item shares one adapter. */
  import: (
    items: Array<Extract<RerunSource, { door: "import" }>>,
    args: RerunReplayArgs
  ) => Promise<Omit<RerunItemResult, "sourceDocumentIds" | "door">>;
}

/** `replace` only. `notClean` lists every proposal that did not fully revert. */
export interface RerunRevertSummary {
  counts: Record<SessionProposalRevertOutcome["outcome"], number>;
  notClean: SessionProposalRevertOutcome[];
  /** The parent's still-pending proposals, withdrawn through `proposals.withdraw`. */
  withdrawnPending: string[];
  /** Pending proposals the withdraw door refused (e.g. not the proposer) — still pending. */
  pendingNotWithdrawn: Array<{ proposalId: string; reason: string }>;
}

/** `replace` only: the parent was NOT reverted, so nothing was replayed. */
export interface RerunRevertNotRun {
  notRun: true;
  reason: string;
}

/** Identical rerun requests inside this window reuse one child session. */
export const RERUN_DEDUPE_WINDOW_MS = 60_000;

/** Why a session cannot be rerun right now, independent of the request. */
export type RerunAvailabilityReason =
  "no_manifest" | "in_flight" | "availability_unknown";

export interface RerunAvailability {
  available: boolean;
  reason?: RerunAvailabilityReason;
}

export type RerunRefusal =
  | "not_found"
  | RerunAvailabilityReason
  | "over_cap"
  | "replace_is_a_human_decision"
  | "no_sources"
  | "mint_failed";

export type RerunSessionResult =
  | { ok: false; reason: RerunRefusal; message: string; plan?: RerunPlan }
  | {
      ok: true;
      status: "dry_run";
      parentSessionId: string;
      mode: RerunMode;
      plan: RerunPlan;
      /** Whether the real run would be allowed — the same rule the door applies. */
      availability: RerunAvailability;
    }
  | {
      ok: true;
      /**
       * An identical request (same parent, mode, user) inside the dedupe window
       * already started this child: nothing was reverted, withdrawn or replayed
       * again. Render the existing child, don't add a second one.
       */
      status: "reused";
      reused: true;
      sessionId: string;
      parentSessionId: string;
      mode: RerunMode;
      idempotencyNamespace: string;
      plan: RerunPlan;
    }
  | {
      ok: true;
      /** `rerun`: every item structured · `partial`: some did not · `failed`: none did. */
      status: "rerun" | "partial" | "failed";
      reused: false;
      sessionId: string;
      parentSessionId: string;
      mode: RerunMode;
      idempotencyNamespace: string;
      plan: RerunPlan;
      /** False when the child's lineage (parent, mode, namespace) could not be recorded. */
      lineageRecorded: boolean;
      revert?: RerunRevertSummary | RerunRevertNotRun;
      items: RerunItemResult[];
      counts: Record<RerunItemOutcome, number>;
    };

/** The parent columns the availability rule reads. */
export interface RerunParent {
  id: string;
  userId: string;
  status: string;
  channelId: string | null;
  metadata: unknown;
}

/** Runs `fn` while the parent row is locked. */
export type ParentLock = <T>(
  parentId: string,
  fn: () => Promise<T>
) => Promise<T>;

/**
 * THE rerun availability rule (see the header). Cheap: no source bodies, one
 * bounded jobs query + one turns query, and only for a non-terminal session.
 */
export async function assessRerunAvailability(
  database: typeof db,
  parent: RerunParent
): Promise<RerunAvailability> {
  const manifest = readSessionRunManifest(parent.metadata);
  if (!manifest || manifest.sourceDocumentIds.length === 0) {
    return { available: false, reason: "no_manifest" };
  }
  if (isTerminalSessionStatus(parent.status)) return { available: true };
  try {
    const session = {
      id: parent.id,
      userId: parent.userId,
      channelId: parent.channelId,
    };
    const [jobs, turns] = await Promise.all([
      listSessionBoundJobs({ database, session, limit: 1 }),
      listRunningSessionTurns({ database, session }),
    ]);
    return jobs.length > 0 || turns.length > 0
      ? { available: false, reason: "in_flight" }
      : { available: true };
  } catch (err) {
    logger.warn(
      { err, sessionId: parent.id },
      "rerun availability: in-flight work could not be read — not offering a rerun"
    );
    return { available: false, reason: "availability_unknown" };
  }
}

const AVAILABILITY_MESSAGES: Record<RerunAvailabilityReason, string> = {
  no_manifest:
    "This session recorded no stored sources, so there is nothing to re-analyse.",
  in_flight:
    "This session still has work in flight (a queued or running job, or a reply being written). Wait for it to finish, or cancel the session, then rerun.",
  availability_unknown:
    "Whether this session still has work in flight could not be checked, so no rerun was started. Try again.",
};

/** Row-lock the parent for the duration of `fn` (decision C). */
export function lockParentForUpdate(database: typeof db): ParentLock {
  return (parentId, fn) =>
    database.transaction(async (tx) => {
      await tx
        .select({ id: focusSessions.id })
        .from(focusSessions)
        .where(eq(focusSessions.id, parentId))
        .for("update");
      return fn();
    });
}

export async function rerunSession(args: {
  sessionId: string;
  userId: string;
  mode: RerunMode;
  scope?: { sourceDocumentIds?: string[] };
  dryRun?: boolean;
  reason?: string;
  /** Set when an agent credential drives the rerun (attribution + the replace floor). */
  agentUserId?: string | null;
  /** The caller's tRPC context; the replay + the revert door run under it. */
  callerContext?: Context;
  /** Injected for tests. */
  replayers?: RerunReplayers;
  revert?: typeof revertSession;
  /** Injected for tests; defaults to the `proposals.withdraw` door. */
  withdrawPending?: (proposalId: string, reason: string) => Promise<unknown>;
  /** Injected for tests; the dedupe window's clock. */
  now?: Date;
  readBytes?: (storageKey: string) => Promise<Buffer>;
  /** Injected for tests; defaults to `SELECT … FOR UPDATE` in a transaction. */
  withParentLock?: ParentLock;
  database?: typeof db;
}): Promise<RerunSessionResult> {
  const database = args.database ?? db;

  const [parent] = await database
    .select({
      id: focusSessions.id,
      userId: focusSessions.userId,
      status: focusSessions.status,
      goal: focusSessions.goal,
      workspaceId: focusSessions.workspaceId,
      projectId: focusSessions.projectId,
      channelId: focusSessions.channelId,
      metadata: focusSessions.metadata,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.id, args.sessionId),
        eq(focusSessions.userId, args.userId)
      )
    )
    .limit(1);
  if (!parent) {
    return {
      ok: false,
      reason: "not_found",
      message: `Focus session ${args.sessionId} not found`,
    };
  }

  const manifest = readSessionRunManifest(parent.metadata);
  if (!manifest || manifest.sourceDocumentIds.length === 0) {
    return {
      ok: false,
      reason: "no_manifest",
      message: AVAILABILITY_MESSAGES.no_manifest,
    };
  }

  const inRun = new Set(manifest.sourceDocumentIds);
  const asked = args.scope?.sourceDocumentIds;
  const notInRun = asked
    ? [...new Set(asked)].filter((id) => !inRun.has(id))
    : [];
  const selectedIds = asked
    ? [...new Set(asked)].filter((id) => inRun.has(id))
    : manifest.sourceDocumentIds;

  const withinCap = selectedIds.length <= RERUN_MAX_SOURCES;
  // Over the cap, only the first cap+1 rows are looked at — enough to count,
  // never an unbounded scan of a huge run.
  const rows = await loadSourceRows(
    database,
    args.userId,
    withinCap ? selectedIds : selectedIds.slice(0, RERUN_MAX_SOURCES + 1)
  );

  const applied = await database
    .select({ id: proposals.id, status: proposals.status })
    .from(proposals)
    .where(
      and(
        eq(proposals.sessionId, parent.id),
        inArray(proposals.status, [
          ProposalStatus.APPROVED,
          ProposalStatus.AUTO_APPROVED,
          ProposalStatus.PENDING,
        ])
      )
    );
  const pendingCount = applied.filter(
    (p) => p.status === ProposalStatus.PENDING
  ).length;

  const captureRows = rows.present.filter((r) => r.door === "capture").length;
  const importRows = rows.present.filter((r) => r.door === "import").length;
  const plan: RerunPlan = {
    sources: {
      selected: selectedIds.length,
      capture: captureRows,
      import: importRows,
      degraded: rows.present.filter((r) => r.degraded).length,
      missing: rows.missing,
      notInRun,
    },
    replaceWouldRevert:
      args.mode === "replace" ? applied.length - pendingCount : 0,
    parentPending: pendingCount,
    estimatedStructureCalls: captureRows + importRows,
    cap: { max: RERUN_MAX_SOURCES, withinCap },
  };

  const availability = await assessRerunAvailability(database, parent);

  // Before the dry run: a confirm must never be shown for an action the real
  // call refuses. The replace floor depends only on WHO is asking, so it is
  // decidable here; the plan still rides along for context.
  if (args.mode === "replace" && args.agentUserId) {
    return {
      ok: false,
      reason: "replace_is_a_human_decision",
      plan,
      message:
        "`replace` reverts work that was already approved, so it is the user's decision. Rerun with mode `add`, or ask the user to replace it from the session room.",
    };
  }

  if (args.dryRun) {
    return {
      ok: true,
      status: "dry_run",
      parentSessionId: parent.id,
      mode: args.mode,
      plan,
      availability,
    };
  }

  if (!availability.available) {
    const reason = availability.reason ?? "availability_unknown";
    return {
      ok: false,
      reason,
      plan,
      message: AVAILABILITY_MESSAGES[reason],
    };
  }
  if (!withinCap) {
    return {
      ok: false,
      reason: "over_cap",
      plan,
      message: `This rerun would re-analyse ${selectedIds.length} sources; the cap is ${RERUN_MAX_SOURCES}. Narrow it with scope.sourceDocumentIds.`,
    };
  }
  if (rows.present.length === 0) {
    return {
      ok: false,
      reason: "no_sources",
      plan,
      message:
        "None of the selected sources still exist (deleted, or not yours), so nothing was rerun.",
    };
  }

  // The replay writes into the parent's placement: re-check write access on the
  // LOADED row, never a request-supplied workspace. A pod-wide session is its
  // owner's (the row's `user_id`), so the owner floor applies there.
  await assertWorkspaceWrite(database, args.userId, {
    workspaceId: parent.workspaceId,
    ownerId: parent.userId,
  });

  const priorIntake = (parent.metadata as Record<string, unknown> | null)?.[
    INTAKE_SESSION_METADATA_KEY
  ] as { door?: unknown } | undefined;
  const lock = args.withParentLock ?? lockParentForUpdate(database);
  // Concurrent reruns of one parent serialize on the parent row; the second one
  // then finds the child by correlation key (same window) instead of minting.
  const minted = await lock(parent.id, () =>
    ensureIntakeSession({
      userId: args.userId,
      workspaceId: parent.workspaceId,
      projectId: parent.projectId,
      agentUserId: args.agentUserId ?? null,
      door:
        priorIntake?.door === "import" || (captureRows === 0 && importRows > 0)
          ? "import"
          : "capture",
      goal: `${resolveActionLabel("rerun", "imperative")} · ${parent.goal}`,
      // A double-click is ONE rerun: the same parent + mode + SCOPE + user inside
      // the window reuses the child `ensureIntakeSession` already minted. The
      // scope is part of the key: "rerun only the degraded sources" right after
      // a full rerun is a different request, never that rerun's child.
      correlationKey: `rerun:${parent.id}:${args.mode}:${rerunScopeKey(asked ? selectedIds : null)}:${args.userId}:${Math.floor(
        (args.now ?? new Date()).getTime() / RERUN_DEDUPE_WINDOW_MS
      )}`,
      parentSessionId: parent.id,
    })
  );
  if (minted.status === "failed") {
    return {
      ok: false,
      reason: "mint_failed",
      plan,
      message: `The rerun session could not be created, so nothing was reverted or rerun: ${minted.error}`,
    };
  }
  const childSessionId = minted.sessionId;
  const idempotencyNamespace = `rerun:${childSessionId}`;
  if (minted.status === "minted" && minted.reused) {
    return {
      ok: true,
      status: "reused",
      reused: true,
      sessionId: childSessionId,
      parentSessionId: parent.id,
      mode: args.mode,
      idempotencyNamespace,
      plan,
    };
  }

  let lineageRecorded = false;
  try {
    const lineage = await recordSessionRunManifest({
      database,
      sessionId: childSessionId,
      userId: args.userId,
      patch: {
        idempotencyNamespace,
        rerun: {
          parentSessionId: parent.id,
          mode: args.mode,
          requestedAt: new Date().toISOString(),
          ...(args.reason ? { reason: args.reason } : {}),
        },
      },
    });
    lineageRecorded = lineage.ok;
  } catch (err) {
    logger.error({ err, childSessionId }, "rerun lineage write threw");
  }
  if (!lineageRecorded) {
    logger.error(
      { childSessionId, parentSessionId: parent.id },
      "rerun lineage NOT recorded on the child manifest"
    );
  }

  const finish = (
    items: RerunItemResult[],
    revert?: RerunRevertSummary | RerunRevertNotRun
  ): RerunSessionResult => {
    const counts: Record<RerunItemOutcome, number> = {
      proposed: 0,
      applied: 0,
      deduplicated: 0,
      not_structured: 0,
      needs_input: 0,
      failed: 0,
    };
    for (const item of items) counts[item.outcome] += 1;
    const good = counts.proposed + counts.applied + counts.deduplicated;
    return {
      ok: true,
      status:
        items.length > 0 && good === items.length
          ? "rerun"
          : good === 0
            ? "failed"
            : "partial",
      reused: false,
      sessionId: childSessionId,
      parentSessionId: parent.id,
      mode: args.mode,
      idempotencyNamespace,
      plan,
      lineageRecorded,
      ...(revert ? { revert } : {}),
      items,
      counts,
    };
  };

  // Bodies only now: every refusal has passed.
  const bodies = await loadSourceBodies(database, rows.present, args.readBytes);
  const unreadableItems: RerunItemResult[] = bodies.unreadable.map((u) => ({
    sourceDocumentIds: [u.sourceDocumentId],
    door: u.door,
    outcome: "failed",
    reason: u.reason,
  }));

  let revert: RerunRevertSummary | RerunRevertNotRun | undefined;
  if (args.mode === "replace") {
    try {
      const reverted = await (args.revert ?? revertSession)({
        sessionId: parent.id,
        userId: args.userId,
        reason: args.reason ?? `Replaced by rerun ${childSessionId}`,
        callerContext: args.callerContext,
        database,
      });
      revert = reverted.ok
        ? {
            counts: reverted.counts,
            notClean: reverted.proposals.filter(
              (o) => o.outcome !== "reverted"
            ),
            ...(await withdrawParentPending({
              pending: applied.filter(
                (p) => p.status === ProposalStatus.PENDING
              ),
              childSessionId,
              withdraw:
                args.withdrawPending ??
                defaultWithdraw(args.userId, args.callerContext),
            })),
          }
        : {
            notRun: true,
            reason: `the parent could not be reverted: ${reverted.reason}`,
          };
    } catch (err) {
      logger.error(
        { err, parentSessionId: parent.id, childSessionId },
        "rerun: reverting the parent threw — nothing replayed"
      );
      revert = {
        notRun: true,
        reason: `the parent could not be reverted: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    // Replace means "undo, then redo". Redoing on top of an undo that never
    // ran would silently turn a replace into an add.
    if ("notRun" in revert) return finish(unreadableItems, revert);
  }

  const replayArgs: RerunReplayArgs = {
    childSessionId,
    idempotencyNamespace,
    workspaceId: parent.workspaceId,
    projectId: parent.projectId,
  };
  const replayers =
    args.replayers ??
    defaultReplayers(args.userId, args.agentUserId ?? null, args.callerContext);

  const items: RerunItemResult[] = [];
  for (const source of bodies.sources) {
    if (source.door !== "capture") continue;
    items.push({
      sourceDocumentIds: [source.sourceDocumentId],
      door: "capture",
      ...(await settle(() => replayers.capture(source, replayArgs))),
    });
  }
  const importGroups = new Map<
    string,
    Array<Extract<RerunSource, { door: "import" }>>
  >();
  for (const source of bodies.sources) {
    if (source.door !== "import") continue;
    const adapter = importSourceForPath(source.item.path);
    importGroups.set(adapter, [...(importGroups.get(adapter) ?? []), source]);
  }
  for (const group of importGroups.values()) {
    items.push({
      sourceDocumentIds: group.map((s) => s.sourceDocumentId),
      door: "import",
      ...(await settle(() => replayers.import(group, replayArgs))),
    });
  }

  return finish([...items, ...unreadableItems], revert);
}

async function withdrawParentPending(args: {
  pending: Array<{ id: string }>;
  childSessionId: string;
  withdraw: (proposalId: string, reason: string) => Promise<unknown>;
}): Promise<
  Pick<RerunRevertSummary, "withdrawnPending" | "pendingNotWithdrawn">
> {
  // A replaced run's undecided proposals are no longer the question: take them
  // out of the queue through the ONE withdraw door. A refusal is listed, never
  // swallowed — that proposal stays pending.
  const withdrawnPending: string[] = [];
  const pendingNotWithdrawn: RerunRevertSummary["pendingNotWithdrawn"] = [];
  for (const p of args.pending) {
    try {
      await args.withdraw(p.id, `Replaced by rerun ${args.childSessionId}`);
      withdrawnPending.push(p.id);
    } catch (err) {
      pendingNotWithdrawn.push({
        proposalId: p.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { withdrawnPending, pendingNotWithdrawn };
}

async function settle(
  run: () => Promise<Omit<RerunItemResult, "sourceDocumentIds" | "door">>
): Promise<Omit<RerunItemResult, "sourceDocumentIds" | "door">> {
  try {
    return await run();
  } catch (err) {
    logger.warn(
      { err },
      "rerun: one source failed to replay (others continue)"
    );
    return {
      outcome: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The scope part of the rerun dedupe key: `all` for the whole run, else a hash
 * of the selected source ids (sorted — the order a host sends them in is not a
 * different request).
 */
export function rerunScopeKey(selectedIds: readonly string[] | null): string {
  if (!selectedIds) return "all";
  return createHash("sha256")
    .update([...selectedIds].sort().join(","))
    .digest("hex")
    .slice(0, 16);
}

/** A stored source's row: what it is and where it lives — no body. */
export interface SourceRow {
  sourceDocumentId: string;
  door: "capture" | "import";
  degraded: boolean;
  meta: IntakeSourceMetadata;
  row: {
    id: string;
    title: string;
    mimeType: string | null;
    storageKey: string | null;
  };
}

/**
 * The run's stored source rows (owner-floored, deleted excluded), in manifest
 * order. Shared by the rerun plan and the room's source list
 * (`listRunSources`), so `degraded` / `missing` mean the same in both.
 */
export async function loadSourceRows(
  database: typeof db,
  userId: string,
  ids: string[]
): Promise<{ present: SourceRow[]; missing: string[] }> {
  if (ids.length === 0) return { present: [], missing: [] };
  const rows = await database
    .select({
      id: documentsTable.id,
      title: documentsTable.title,
      mimeType: documentsTable.mimeType,
      storageKey: documentsTable.storageKey,
      metadata: documentsTable.metadata,
    })
    .from(documentsTable)
    .where(
      and(
        inArray(documentsTable.id, ids),
        eq(documentsTable.userId, userId),
        isNull(documentsTable.deletedAt)
      )
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const present: SourceRow[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    const meta = (row?.metadata as Record<string, unknown> | null)?.[
      INTAKE_SOURCE_METADATA_KEY
    ] as IntakeSourceMetadata | undefined;
    if (!row || !meta) {
      missing.push(id);
      continue;
    }
    present.push({
      sourceDocumentId: id,
      door: meta.kind === "import_item" ? "import" : "capture",
      degraded: Boolean(meta.degraded),
      meta,
      row: {
        id: row.id,
        title: row.title,
        mimeType: row.mimeType,
        storageKey: row.storageKey,
      },
    });
  }
  return { present, missing };
}

async function loadSourceBodies(
  database: typeof db,
  rows: SourceRow[],
  readBytes?: (storageKey: string) => Promise<Buffer>
): Promise<{
  sources: RerunSource[];
  unreadable: Array<{
    sourceDocumentId: string;
    door: "capture" | "import";
    reason: string;
  }>;
}> {
  const read =
    readBytes ??
    (async (key: string) => {
      const { storage } = await import("@synap/storage");
      return storage.downloadBuffer(key);
    });

  const sources: RerunSource[] = [];
  const unreadable: Array<{
    sourceDocumentId: string;
    door: "capture" | "import";
    reason: string;
  }> = [];
  for (const { sourceDocumentId: id, door, degraded, meta, row } of rows) {
    // Stored ORIGINAL bytes (a degraded / non-extracted file): replay the file.
    const isBytes =
      meta.kind === "file" &&
      row.mimeType !== "text/markdown" &&
      row.storageKey;
    if (isBytes) {
      try {
        const buffer = await read(row.storageKey!);
        sources.push({
          sourceDocumentId: id,
          door: "capture",
          kind: "file",
          degraded,
          input: {
            file: {
              content: buffer.toString("base64"),
              mimeType:
                meta.mimeType ?? row.mimeType ?? "application/octet-stream",
              ...(meta.filename ? { filename: meta.filename } : {}),
              encoding: "base64",
            },
          },
        });
      } catch (err) {
        unreadable.push({
          sourceDocumentId: id,
          door,
          reason: `the stored file could not be read: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      continue;
    }

    const body = await readText(database, row, read);
    if (!body?.trim()) {
      unreadable.push({
        sourceDocumentId: id,
        door,
        reason: "source document has no readable body",
      });
      continue;
    }
    if (meta.kind === "import_item") {
      sources.push({
        sourceDocumentId: id,
        door: "import",
        kind: "import_item",
        degraded,
        item: { path: meta.path ?? row.title, content: body },
      });
    } else if (meta.kind === "url" && meta.url) {
      sources.push({
        sourceDocumentId: id,
        door: "capture",
        kind: "url",
        degraded,
        input: {
          url: meta.url,
          ...(body !== meta.url
            ? { html: body.slice(0, STRUCTURE_HTML_MAX) }
            : {}),
        },
      });
    } else if (body.length <= STRUCTURE_TEXT_MAX && meta.kind === "text") {
      sources.push({
        sourceDocumentId: id,
        door: "capture",
        kind: "text",
        degraded,
        input: { text: body },
      });
    } else {
      // Extracted file text, or a body over the structure text cap: the IS
      // normalises a text file the same way it normalised the original.
      sources.push({
        sourceDocumentId: id,
        door: "capture",
        kind: meta.kind === "file" ? "file" : "text",
        degraded,
        input: {
          file: {
            content: body,
            mimeType: "text/markdown",
            filename: meta.filename ?? `${row.title}.md`,
            encoding: "utf8",
          },
        },
      });
    }
  }
  return { sources, unreadable };
}

async function readText(
  database: typeof db,
  row: { id: string; storageKey: string | null },
  read: (storageKey: string) => Promise<Buffer>
): Promise<string | null> {
  // The stored markdown object is the full body; the version row is a ≤64k
  // preview, used only when there is no object.
  if (row.storageKey) {
    try {
      return (await read(row.storageKey)).toString("utf8");
    } catch (err) {
      logger.warn(
        { err, documentId: row.id },
        "rerun: source object unreadable — falling back to the version content"
      );
    }
  }
  const [version] = await database
    .select({ content: documentVersions.content })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, row.id))
    .orderBy(desc(documentVersions.version))
    .limit(1);
  return version?.content ?? null;
}

/** `proposals.withdraw` under the caller's own ctx — its proposer rule applies. */
function defaultWithdraw(
  userId: string,
  callerContext: Context | undefined
): (proposalId: string, reason: string) => Promise<unknown> {
  return async (proposalId, reason) => {
    // Lazy: the proposals router imports back into services.
    const { proposalsRouter } = await import("../../routers/proposals.js");
    const caller = proposalsRouter.createCaller(
      callerContext ?? { db, authenticated: true, userId }
    );
    return caller.withdraw({ proposalId, reason });
  };
}

/** Import source adapter chosen from the item's own path (not stored on the run). */
export function importSourceForPath(path: string): "csv" | "json" | "markdown" {
  const ext = path.toLowerCase().split(".").pop();
  if (ext === "csv") return "csv";
  if (ext === "json") return "json";
  return "markdown";
}

/** The caller's ctx, re-pointed at the room a replay files into. */
function replayContext(
  userId: string,
  agentUserId: string | null,
  callerContext: Context | undefined,
  a: RerunReplayArgs
) {
  return {
    ...(callerContext ?? { db, authenticated: true, userId }),
    userId,
    workspaceId: a.workspaceId,
    // The room this replay files into (owned: minted by the caller).
    sessionId: a.childSessionId,
    ...(agentUserId ? { agentUserId } : {}),
  };
}

/**
 * ONE capture source through the real capture door: `capture.structure` →
 * `submitCaptureGraph`, filed into `a.childSessionId`. Exported so every door
 * that re-structures stored text (rerun, "Structure again") replays through the
 * same path rather than a second pipeline.
 */
export async function replayCaptureSource(
  source: Extract<RerunSource, { door: "capture" }>,
  a: RerunReplayArgs,
  who: {
    userId: string;
    agentUserId: string | null;
    callerContext: Context | undefined;
  }
): Promise<Omit<RerunItemResult, "sourceDocumentIds" | "door">> {
  const { userId, agentUserId } = who;
  const ctx = replayContext(userId, agentUserId, who.callerContext, a);
  const [{ captureRouter }, toGraph, submit, narrative, { openLink }] =
    await Promise.all([
      import("../../routers/capture.js"),
      import("../capture-agent/capture-structure-to-graph.js"),
      import("../capture-agent/submit-capture-graph.js"),
      import("../capture-agent/capture-narrative.js"),
      import("../../utils/deep-links.js"),
    ]);
  const caller = captureRouter.createCaller(
    ctx as Parameters<typeof captureRouter.createCaller>[0]
  );
  const result = await caller.structure({
    ...source.input,
    // A replay re-analyzes ON PURPOSE: bypass the already-analyzed ledger
    // (W4b) — a stored photo/file would otherwise come back not_structured.
    reanalyze: true,
    sessionId: a.childSessionId,
  });
  const plan =
    result as unknown as import("../capture-agent/capture-structure-to-graph.js").CaptureStructureLike;
  if (!toGraph.shouldPersistCapturePlan(plan)) {
    const r = result as {
      followUp?: unknown;
      degraded?: unknown;
      degradedReason?: unknown;
    };
    if (r.followUp) {
      return {
        outcome: "needs_input",
        reason: "the structurer asked a question instead of proposing",
      };
    }
    return {
      outcome: "not_structured",
      reason:
        typeof r.degradedReason === "string"
          ? r.degradedReason
          : r.degraded === true
            ? "degraded"
            : "nothing to propose",
    };
  }
  const { entities, relations } = toGraph.captureStructureToGraph(plan);
  const targetWorkspaceId =
    typeof (result as { targetWorkspaceId?: unknown }).targetWorkspaceId ===
    "string"
      ? (result as { targetWorkspaceId: string }).targetWorkspaceId
      : a.workspaceId;
  const narrativeSummary = narrative.buildCaptureNarrativeSummary({
    sourceLabel: resolveActionLabel("rerun", "imperative"),
    instruction: source.input.text,
    sourceUrl: source.input.url,
  });
  const graph = await submit.submitCaptureGraph({
    userId,
    ...(agentUserId ? { agentUserId } : {}),
    workspaceId: targetWorkspaceId,
    ...(a.projectId ? { projectId: a.projectId } : {}),
    sessionId: a.childSessionId,
    entities,
    relations,
    rawSource: {
      ...(source.input.text ? { rawText: source.input.text } : {}),
      ...(source.input.url ? { sourceUrl: source.input.url } : {}),
      idempotencyKey: `${a.idempotencyNamespace}:${source.sourceDocumentId}`,
    },
    // undefined only when neither text nor url is known (a file source).
    summary: narrativeSummary,
  });
  return {
    outcome: graph.writeReceipt.state === "pending" ? "proposed" : "applied",
    ...(graph.proposalId ? { proposalId: graph.proposalId } : {}),
    ...(graph.proposalId && graph.writeReceipt.state === "pending"
      ? { reviewUrl: graph.reviewUrl ?? openLink(graph.proposalId) }
      : {}),
  };
}

/** The real intake doors — the same ones a first run goes through. */
function defaultReplayers(
  userId: string,
  agentUserId: string | null,
  callerContext: Context | undefined
): RerunReplayers {
  return {
    capture: (source, a) =>
      replayCaptureSource(source, a, { userId, agentUserId, callerContext }),
    import: async (items, a) => {
      const { ImportOrchestrator } = await import("../import-orchestrator.js");
      // The caller groups by adapter, so every item here shares this one.
      const source = importSourceForPath(items[0]!.item.path);
      const orchestrator = new ImportOrchestrator({
        workspaceId: a.workspaceId,
        userId,
        trpcCtx: replayContext(userId, agentUserId, callerContext, a),
        sessionId: a.childSessionId,
        projectId: a.projectId,
      });
      const result = await orchestrator.analyze({
        source,
        items: items.map((s) => s.item),
        sessionId: a.childSessionId,
        // The rerun's own dedup namespace: the parent's identical graph is
        // never handed back; only a retry inside THIS rerun dedups.
        idempotencyNamespace: a.idempotencyNamespace,
      });
      if (!result.proposalId) {
        return { outcome: "not_structured", reason: "no graph was proposed" };
      }
      return {
        outcome: result.deduplicated ? "deduplicated" : "proposed",
        proposalId: result.proposalId,
        ...(result.deduplicated
          ? {
              reason:
                "this rerun already proposed an identical import graph — its proposal is returned, not a new one",
            }
          : {}),
      };
    },
  };
}
