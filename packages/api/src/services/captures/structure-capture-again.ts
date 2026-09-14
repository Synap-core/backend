/**
 * captures.structureAgain — redo ONE capture from its raw (founder rule: redo
 * from raw, never lose it), including a capture that was staged with NO run
 * (an offline `capture.execute`, a failed session ensure).
 *
 * No second structuring path: every redo is `rerunSession` scoped to
 * `[documentId]`, answering in its shapes (dry run, refusals, outcome).
 *
 *   1. load the capture through `scopedDb` + the owner narrow
 *      (`ownCapturesWhere`) — a foreign or missing id is `not_found`;
 *   2. refuse a kind that is not a user capture (`unsupported_kind`) — the rerun
 *      would otherwise replay a machine source as a text capture;
 *   3. refuse `replace` when the capture's run holds OTHER sources
 *      (`replace_wider_than_capture`): `replace` reverts the WHOLE run, so a
 *      one-capture redo must never undo a sibling capture's work;
 *   4. the capture is in its run's manifest ⇒ delegate as is;
 *   5. otherwise — no run, a run the caller no longer has, or a run whose
 *      manifest lost it — ADOPT it: mint an intake run (`ensureIntakeSession`,
 *      one per capture via its correlation key) unless the run still exists,
 *      record the capture on the manifest, stamp `intakeSource.sessionId` when
 *      it was null, then delegate. `dryRun` writes none of that: its plan comes
 *      from `planRerun`, the same builder the rerun door uses.
 *
 * A stored file's ORIGINAL bytes (incl. `retainedUntilStructured`) replay as
 * that file — the rerun door's body loader — and nothing is ever removed.
 */

import {
  db,
  and,
  eq,
  documents,
  focusSessions,
  DocumentRepository,
  eventRepository,
} from "@synap/database";
import type { Context } from "../../types/context.js";
import { AccessContext, scopedDb } from "../../access/index.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { ensureIntakeSession } from "../intake/ensure-intake-session.js";
import {
  mergeRunManifest,
  readSessionRunManifest,
  recordSessionRunManifest,
} from "../intake/record-session-run-manifest.js";
import {
  INTAKE_SOURCE_METADATA_KEY,
  type IntakeSourceMetadata,
} from "../intake/stage-intake-source.js";
import {
  assessRerunAvailability,
  planRerun,
  rerunSession,
  REPLACE_IS_A_HUMAN_DECISION_MESSAGE,
  type RerunMode,
  type RerunSessionResult,
} from "../focus-sessions/rerun-session.js";
import { CAPTURE_LIST_KINDS, ownCapturesWhere } from "./capture-scope.js";

export type CaptureStructureAgainRefusal =
  | "not_found"
  | "unsupported_kind"
  | "replace_wider_than_capture"
  | "manifest_not_recorded";

type RerunDryRun = Extract<RerunSessionResult, { status: "dry_run" }>;

export type CaptureStructureAgainResult = (
  | Exclude<RerunSessionResult, RerunDryRun>
  /** A capture with no run yet previews with no parent. */
  | (Omit<RerunDryRun, "parentSessionId"> & { parentSessionId: string | null })
  | { ok: false; reason: CaptureStructureAgainRefusal; message: string }
) & {
  /** The run that holds this capture (null when it has none and none was made). */
  runSessionId: string | null;
};

export async function structureCaptureAgain(args: {
  documentId: string;
  userId: string;
  mode: RerunMode;
  dryRun?: boolean;
  reason?: string;
  agentUserId?: string | null;
  /** The caller's tRPC context: the access floor, and the rerun runs under it. */
  callerContext: Context;
  /** Injected for tests; defaults to the rerun door. */
  rerun?: typeof rerunSession;
  database?: typeof db;
}): Promise<CaptureStructureAgainResult> {
  const database = args.database ?? db;
  const rerun = args.rerun ?? rerunSession;

  const doc = await scopedDb(AccessContext.from(args.callerContext)).findFirst<{
    id: string;
    userId: string;
    workspaceId: string | null;
    title: string | null;
    metadata: Record<string, unknown> | null;
  }>(documents, {
    where: and(
      ownCapturesWhere(args.userId),
      eq(documents.id, args.documentId)
    ),
    columns: {
      id: true,
      userId: true,
      workspaceId: true,
      title: true,
      metadata: true,
    },
  });
  if (!doc) {
    return {
      ok: false,
      reason: "not_found",
      message: `Capture ${args.documentId} not found`,
      runSessionId: null,
    };
  }
  const meta = doc.metadata ?? {};
  const source = meta[INTAKE_SOURCE_METADATA_KEY] as IntakeSourceMetadata;

  if (!(CAPTURE_LIST_KINDS as ReadonlyArray<string>).includes(source.kind)) {
    return {
      ok: false,
      reason: "unsupported_kind",
      message: `This source (${source.kind}) is not a capture, so it cannot be structured again from here.`,
      runSessionId: source.sessionId ?? null,
    };
  }

  // The run that holds this raw — only while it is still the caller's.
  const [run] = source.sessionId
    ? await database
        .select({
          id: focusSessions.id,
          userId: focusSessions.userId,
          status: focusSessions.status,
          channelId: focusSessions.channelId,
          metadata: focusSessions.metadata,
        })
        .from(focusSessions)
        .where(
          and(
            eq(focusSessions.id, source.sessionId),
            eq(focusSessions.userId, args.userId)
          )
        )
        .limit(1)
    : [];
  const manifest = run ? readSessionRunManifest(run.metadata) : undefined;
  const inRun = manifest?.sourceDocumentIds ?? [];

  if (args.mode === "replace" && inRun.some((id) => id !== doc.id)) {
    return {
      ok: false,
      reason: "replace_wider_than_capture",
      message:
        "`replace` would undo the whole run this capture belongs to, including other captures. Structure it again with `add`, or replace the run from its room.",
      runSessionId: run!.id,
    };
  }

  const delegate = async (sessionId: string) => ({
    ...(await rerun({
      sessionId,
      userId: args.userId,
      mode: args.mode,
      scope: { sourceDocumentIds: [doc.id] },
      dryRun: args.dryRun,
      reason: args.reason,
      agentUserId: args.agentUserId ?? null,
      callerContext: args.callerContext,
      database,
    })),
    runSessionId: sessionId,
  });

  if (run && inRun.includes(doc.id)) return delegate(run.id);

  // ── Adopt: the capture is in no run the caller has ─────────────────────────
  // Refused BEFORE anything is written, exactly as the rerun door would.
  if (args.mode === "replace" && args.agentUserId) {
    return {
      ok: false,
      reason: "replace_is_a_human_decision",
      message: REPLACE_IS_A_HUMAN_DECISION_MESSAGE,
      runSessionId: run?.id ?? null,
    };
  }

  if (args.dryRun) {
    const { plan } = await planRerun(database, {
      parentSessionId: run?.id ?? null,
      userId: args.userId,
      mode: args.mode,
      selectedIds: [doc.id],
      notInRun: [],
    });
    const availability = run
      ? await assessRerunAvailability(database, {
          ...run,
          // As the run will read once the capture is recorded on it.
          metadata: {
            ...((run.metadata as Record<string, unknown> | null) ?? {}),
            run: mergeRunManifest(manifest, { sourceDocumentIds: [doc.id] }),
          },
        })
      : { available: true };
    return {
      ok: true,
      status: "dry_run",
      parentSessionId: run?.id ?? null,
      mode: args.mode,
      plan,
      availability,
      runSessionId: run?.id ?? null,
    };
  }

  // The run files into the capture's placement: write access on the LOADED row.
  await assertWorkspaceWrite(database, args.userId, {
    workspaceId: doc.workspaceId,
    ownerId: doc.userId,
  });

  let runSessionId = run?.id ?? null;
  if (!runSessionId) {
    const minted = await ensureIntakeSession({
      userId: args.userId,
      workspaceId: doc.workspaceId,
      projectId: null,
      agentUserId: args.agentUserId ?? null,
      door: source.kind === "import_item" ? "import" : "capture",
      goal: `Capture · ${(doc.title ?? "untitled").slice(0, 80)}`,
      // One run per capture: a second press re-finds it instead of minting.
      correlationKey: `capture-run:${doc.id}`,
    });
    if (minted.status === "failed") {
      return {
        ok: false,
        reason: "mint_failed",
        message: `The run could not be created, so nothing was structured: ${minted.error}`,
        runSessionId: null,
      };
    }
    runSessionId = minted.sessionId;
  }

  const recorded = await recordSessionRunManifest({
    database,
    sessionId: runSessionId,
    userId: args.userId,
    patch: { sourceDocumentIds: [doc.id] },
  });
  if (!recorded.ok) {
    return {
      ok: false,
      reason: "manifest_not_recorded",
      message:
        "The capture could not be recorded on its run, so nothing was structured. Try again.",
      runSessionId,
    };
  }

  if (!source.sessionId) {
    await new DocumentRepository(database, eventRepository).update(
      doc.id,
      {
        metadata: {
          ...meta,
          [INTAKE_SOURCE_METADATA_KEY]: { ...source, sessionId: runSessionId },
        },
      },
      args.userId
    );
  }

  return delegate(runSessionId);
}
