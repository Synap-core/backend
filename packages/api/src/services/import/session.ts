import {
  db,
  linkEntityToProject,
  proposals,
  ProposalStatus,
  eq,
  and,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { CsvTablePlan } from "../../import/import-adapters.js";
import type { OrchestratorContext } from "./types.js";
import type { ImportAnalyzeInput } from "../import-orchestrator.js";
import { ensureIntakeSession } from "../intake/ensure-intake-session.js";
import { resolveVerifiedSessionId } from "../../routers/hub-protocol/_middleware/session.js";
import {
  stampMaterialized,
  type CompleteMaterializedRecord,
} from "../proposals/stamp-materialized.js";

const logger = createLogger({ module: "import-orchestrator/session" });

/**
 * Resolve the session (run room) this import attaches to. Intake decision 1:
 * an import that files a proposal ALWAYS belongs to a session.
 *
 * 1. A caller-supplied sessionId the caller OWNS (`resolveVerifiedSessionId`).
 *    It used to be passed straight through, so an import could file its
 *    proposal — and on apply, its `produced` links — into another user's
 *    session. An unowned handle is now ignored, and the result says so.
 * 2. Playbook-templated session when `input.playbookId` is set.
 * 3. Otherwise a minted intake session (`ensureIntakeSession` — a `run`). The
 *    old "N≥2 items or forceSession" rule is gone: a one-item import that files
 *    a proposal needs its room too, so `forceSession` no longer changes anything.
 *
 * Best-effort: a mint failure never fails the import, but it is REPORTED
 * (`sessionSource: "failed"` + `error`), never folded into "no session".
 */
export interface ImportSessionResolution {
  sessionId: string | null;
  /**
   * `prior` = the session of the identical graph proposed earlier (a re-sent
   * analyze lands back in its room); `none` = no session resolved by design
   * (the verified-handle-only phase, or a prior proposal that had none).
   */
  sessionSource:
    "provided" | "playbook" | "minted" | "prior" | "none" | "failed";
  /** A handle was sent and a different session was used. */
  requestedSessionIgnored: boolean;
  error?: string;
}

/** The acting agent carried on an untyped `trpcCtx` — a non-empty string or nothing. */
function agentUserIdOf(trpcCtx: unknown): string | null {
  const value = (trpcCtx as { agentUserId?: unknown } | undefined)?.agentUserId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function resolveImportSession(
  ctx: OrchestratorContext,
  input: ImportAnalyzeInput,
  _tablePlan?: CsvTablePlan | null,
  /**
   * `mint: false` resolves ONLY a handle the caller owns — no playbook session,
   * no mint. Analyze runs this phase before its duplicate lookup, so a re-sent
   * analyze can reuse the PRIOR proposal's session instead of minting an empty
   * one (and staging its sources twice).
   */
  opts: { mint?: boolean } = {}
): Promise<ImportSessionResolution> {
  const requested = input.sessionId ?? null;
  const verified = requested
    ? await resolveVerifiedSessionId(ctx.userId, null, requested)
    : undefined;
  if (verified) {
    return {
      sessionId: verified,
      sessionSource: "provided",
      requestedSessionIgnored: false,
    };
  }
  const requestedSessionIgnored = requested !== null;
  if (opts.mint === false) {
    return { sessionId: null, sessionSource: "none", requestedSessionIgnored };
  }

  // Playbook-templated session (goal / outputs / playbook FK).
  if (input.playbookId && ctx.workspaceId) {
    const { instantiateSession } =
      await import("../playbooks/playbook-lifecycle.js");
    try {
      const session = await instantiateSession({
        playbookId: input.playbookId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        params: input.playbookParams,
      });
      return {
        sessionId: session.id,
        sessionSource: "playbook",
        requestedSessionIgnored,
      };
    } catch (err) {
      // Best-effort — an import must not fail because a playbook
      // instantiation hiccupped. It falls through to a minted intake room, so
      // the run still has a session.
      logger.warn(
        { err, playbookId: input.playbookId },
        "import: playbook session instantiation failed — minting an intake session instead"
      );
    }
  }

  const itemCount = input.items?.length ?? 0;
  const goal =
    itemCount > 0
      ? `Import ${itemCount} ${input.source} item${itemCount === 1 ? "" : "s"}`
      : `Import ${input.source}`;
  const minted = await ensureIntakeSession({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId ?? null,
    projectId: ctx.projectId ?? null,
    // The acting AGENT rides `ctx.trpcCtx` — omitting it labelled every
    // agent-key import room `origin:"human"` (ensureIntakeSession treats
    // `origin` as "agent" only when `agentUserId` is set). `trpcCtx` is an
    // untyped record, so only a non-empty string is an agent id.
    agentUserId: agentUserIdOf(ctx.trpcCtx),
    door: "import",
    goal,
  });
  if (minted.status === "failed") {
    return {
      sessionId: null,
      sessionSource: "failed",
      requestedSessionIgnored,
      error: minted.error,
    };
  }
  return {
    sessionId: minted.sessionId,
    sessionSource: "minted",
    requestedSessionIgnored,
  };
}

/**
 * Resolve a playbook's target profileSlug from its `expectedOutputs[0].kind`,
 * so the playbook is the single source of truth for entity typing (overriding
 * the IS-inferred slug). Returns null when the playbook has no declared output
 * kind or is not found.
 */
export async function resolvePlaybookOutputKind(
  playbookId: string
): Promise<{ profileSlug: string } | null> {
  const row = await db.query.playbooks.findFirst({
    where: (fields, { eq }) => eq(fields.id, playbookId),
    columns: { expectedOutputs: true },
  });
  if (!row) return null;
  const outputs = row.expectedOutputs as Array<{ kind?: string }> | null;
  const kind = outputs?.[0]?.kind;
  return kind ? { profileSlug: kind } : null;
}

/**
 * File freshly-materialized entities into a project (`belongs_to_project`).
 *
 * Preference order per entity:
 *   1. Skip when materialize already filed a project (op.projectId → entities.create
 *      already ran linkEntityToProject) — re-stamping would be redundant.
 *   2. Else fall back to the active project lens on the orchestrator ctx.
 *
 * Skips linked-existing entities (don't re-home pre-existing graph members).
 * `linkEntityToProject` remains idempotent as a belt-and-suspenders guard.
 * The single membership write for both import paths (apply + applyLarge).
 */
export async function stampProjectMembership(
  ctx: OrchestratorContext,
  entities: {
    entityId: string;
    linked?: boolean;
    /** Project already filed at materialize time (from op.projectId). */
    projectId?: string | null;
  }[]
): Promise<void> {
  for (const e of entities) {
    if (e.linked) continue;
    // Materialize already stamped membership via entities.create — skip.
    if (e.projectId) continue;
    const projectId = ctx.projectId;
    if (!projectId) continue;
    await linkEntityToProject(db, {
      entityId: e.entityId,
      projectId,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
  }
}

/**
 * After a successful human apply of an `import.graph` proposal, record what the
 * apply materialized on the analyze-time proposal row, then mark it APPROVED
 * (it was the user's confirmation). Only flips PENDING → APPROVED; best-effort —
 * never fails the import if either write hiccups (the materialize already
 * landed; the row is audit, not a gate).
 *
 * The record is what makes an import undoable: without it `revert` had nothing
 * to invert and fell back to the proposal's placeholder `targetId`, so "Undo
 * import" always failed. It is written even when the flip does not match (a
 * concurrent apply already approved the row) — the record MERGES, so a retry's
 * record never erases the first attempt's.
 *
 * Human apply is the review step, so status is APPROVED (not AUTO_APPROVED).
 * There is no `resolvedAt` column on proposals — `reviewedAt` is the review stamp.
 */
export async function closeImportProposalOnApply(
  proposalId: string | null | undefined,
  reviewedBy: string,
  record?: CompleteMaterializedRecord
): Promise<void> {
  if (!proposalId) return;
  if (record) {
    try {
      await stampMaterialized({ proposalId, record });
    } catch (err) {
      logger.error(
        { err, proposalId },
        "import.apply: materialized record NOT stamped — this import cannot be undone (import preserved)"
      );
    }
  }
  try {
    await db
      .update(proposals)
      .set({
        status: ProposalStatus.APPROVED,
        reviewedBy,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(proposals.id, proposalId),
          eq(proposals.status, ProposalStatus.PENDING)
        )
      );
  } catch (err) {
    logger.warn(
      { err, proposalId },
      "import.apply: failed to close proposal (import preserved)"
    );
  }
}
