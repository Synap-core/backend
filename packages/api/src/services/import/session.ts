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
import { createFocusSession } from "../focus-sessions/create-session.js";

const logger = createLogger({ module: "import-orchestrator/session" });

/**
 * Resolve the session this import attaches to:
 * 1. Caller-supplied sessionId (pass-through).
 * 2. Playbook-templated session when `input.playbookId` is set.
 * 3. Auto-mint a bare `Import …` focus session when N≥2 items OR
 *    `forceSession` is true (founder: both paths). Best-effort — never fail import.
 * 4. Otherwise null (single-item / tiny import may stay session-agnostic).
 */
export async function resolveImportSession(
  ctx: OrchestratorContext,
  input: ImportAnalyzeInput,
  _tablePlan?: CsvTablePlan | null
): Promise<string | null> {
  if (input.sessionId) return input.sessionId;

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
      return session.id;
    } catch (err) {
      // Session instantiation is best-effort — an import must not fail
      // because a playbook instantiation hiccupped. Log and return null
      // (the import still completes; it just won't be session-attached).
      logger.warn(
        { err, playbookId: input.playbookId },
        "import: playbook session instantiation failed (import preserved)"
      );
      return null;
    }
  }

  const itemCount = input.items?.length ?? 0;
  const shouldMint = input.forceSession === true || itemCount >= 2;
  if (!shouldMint) return null;

  try {
    const goal =
      itemCount > 0
        ? `Import ${itemCount} ${input.source} item${itemCount === 1 ? "" : "s"}`
        : `Import ${input.source}`;
    const created = await createFocusSession({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId ?? null,
      projectId: ctx.projectId ?? null,
      goal,
      expectedOutputs: [
        {
          kind: "entity",
          label: "Things to organize",
          status: "pending",
        },
      ],
    });
    if (created.status === "created") {
      return created.session.id;
    }
    // Proposed (agent governance) — import continues without session attachment.
    logger.info(
      { proposalId: created.proposalId, itemCount },
      "import: bare Import session proposed (import continues without sessionId)"
    );
    return null;
  } catch (err) {
    logger.warn(
      { err, itemCount },
      "import: bare Import session mint failed (import preserved)"
    );
    return null;
  }
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
 * After a successful human apply of an `import.graph` proposal, mark the
 * analyze-time proposal row APPROVED (it was the user's confirmation). Only
 * flips PENDING → APPROVED; best-effort — never fails the import if the update
 * hiccups (the materialize already landed; the row is audit, not a gate).
 *
 * Human apply is the review step, so status is APPROVED (not AUTO_APPROVED).
 * There is no `resolvedAt` column on proposals — `reviewedAt` is the review stamp.
 */
export async function closeImportProposalOnApply(
  proposalId: string | null | undefined,
  reviewedBy: string
): Promise<void> {
  if (!proposalId) return;
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
