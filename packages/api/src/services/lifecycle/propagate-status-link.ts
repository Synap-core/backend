/**
 * Status-link propagation — Phase 0/1 of the dynamic status links plan
 * (decision aa0de6e6, synthesis doc 5b71a257).
 *
 * When an entity's lifecycle status moves, every `entity_links` row with
 * `link_type = "status-propagates"` and `source_entity_id = <that entity>`
 * asks the target entity to move too. The target move is written through the
 * governed `moveStatus` door — never a raw status write — so a target the
 * actor may not touch is refused, not bypassed.
 *
 * ONE hop, no cascade: propagation moves the source's direct link targets only
 * (targets' own links are not followed). A propagation is a side effect:
 * failures are logged and reported, never thrown into the move that triggered
 * them.
 *
 * Phase 1 — governance boundary: propagation AUTO-APPLIES only within the
 * same playbook stage. A move is provably in-stage when its session exists,
 * is at a current stage, the moved entity is that session's subject AND the
 * moved status is the current stage's own subject status (or the stage
 * declares no status). Anything else is surfaced as a `proposed` outcome —
 * nothing is propagated; the links stand and a person reviews the ripple.
 */
import { and, eq } from "drizzle-orm";
import { db, entityLinks, entities, focusSessions, playbooks } from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { StatusMoveActor } from "./move-status.js";
import { withPropagationScope } from "./propagation-guard.js";

const logger = createLogger({ module: "propagate-status-link" });

export interface PropagateContext {
  actor: StatusMoveActor;
  sessionId?: string | null;
  workspaceId?: string | null;
  reason?: string | null;
}

export interface PropagatedHop {
  targetEntityId: string;
  sourceStatus: string;
  targetStatus: string;
}

export interface SkippedHop {
  targetEntityId: string;
  reason: string;
}

/**
 * `applied`: propagation ran (possibly partial) and `propagated` / `skipped`
 * carry the hops. `proposed`: the move was NOT provably within the session's
 * stage — nothing was propagated; the links stand and a person reviews the
 * ripple. `proposalId` is null in Phase 1: the marker is surfaced, not filed
 * as a proposal row.
 */
export interface PropagateStatusLinkResult {
  status: "applied" | "proposed";
  proposalId: null;
  reason?: string;
  propagated: PropagatedHop[];
  skipped: SkippedHop[];
}

/**
 * The target status a link row asks for: the `mapping` in the link's config
 * (source status → target status) if present, else the same status copied
 * across.
 */
function targetStatusFor(config: unknown, sourceStatus: string): string {
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const mapping = (config as Record<string, unknown>).mapping;
    if (mapping && typeof mapping === "object" && !Array.isArray(mapping)) {
      const mapped = (mapping as Record<string, unknown>)[sourceStatus];
      if (typeof mapped === "string" && mapped.length > 0) return mapped;
    }
  }
  return sourceStatus;
}

interface StageCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Phase 1 — could this move ripple within the session's stage? Conservative on
 * purpose: a move is provably in-stage only when the session is at a stage,
 * the moved entity is that session's subject and the moved status is the
 * current stage's own subject status (a stage that declares none is not
 * status-owned and holds nothing to check against).
 */
async function checkInStage(
  context: PropagateContext,
  sourceEntityId: string,
  newStatus: string
): Promise<StageCheck> {
  if (!context.sessionId) {
    return { ok: false, reason: "no session — the move carries no stage" };
  }
  const [session] = await db
    .select({
      currentStage: focusSessions.currentStage,
      subjectEntityId: focusSessions.subjectEntityId,
      playbookId: focusSessions.playbookId,
    })
    .from(focusSessions)
    .where(eq(focusSessions.id, context.sessionId))
    .limit(1);
  if (!session) {
    return { ok: false, reason: "session not found" };
  }
  if (!session.currentStage) {
    return { ok: false, reason: "session has no current stage" };
  }
  if (session.subjectEntityId !== sourceEntityId) {
    return {
      ok: false,
      reason: "moved entity is not the session's subject — not in-stage",
    };
  }
  if (session.playbookId) {
    const [playbook] = await db
      .select({ stages: playbooks.stages })
      .from(playbooks)
      .where(eq(playbooks.id, session.playbookId))
      .limit(1);
    const stages = (playbook?.stages ?? []) as Array<{
      key?: string;
      subjectStatus?: string | null;
    }>;
    const stage = stages.find((s) => s.key === session.currentStage);
    if (stage && stage.subjectStatus != null && stage.subjectStatus !== newStatus) {
      return {
        ok: false,
        reason: `moved status "${newStatus}" is not the current stage ("${session.currentStage}")'s status`,
      };
    }
  }
  return { ok: true };
}

export async function propagateStatusLink(
  sourceEntityId: string,
  newStatus: string,
  context: PropagateContext
): Promise<PropagateStatusLinkResult> {
  const result: PropagateStatusLinkResult = {
    status: "applied",
    proposalId: null,
    propagated: [],
    skipped: [],
  };

  const links = await db
    .select()
    .from(entityLinks)
    .where(
      and(
        eq(entityLinks.sourceEntityId, sourceEntityId),
        eq(entityLinks.linkType, "status-propagates")
      )
    );
  if (links.length === 0) return result;

  // Phase 1 — the ripple is only applied within the session's stage. The
  // stage check runs only when there is something to ripple (the links above),
  // keeping the common case — no links — to one cheap indexed select.
  const stage = await checkInStage(context, sourceEntityId, newStatus);
  if (!stage.ok) {
    logger.info(
      { sourceEntityId, reason: stage.reason },
      "status-link propagation proposed — not in-stage"
    );
    return {
      status: "proposed",
      proposalId: null,
      reason: stage.reason,
      propagated: [],
      skipped: [],
    };
  }

  // Guard: the moveStatus call below would re-enter this module. Phase 0 is
  // one hop — a propagation does not trigger further propagations. Scoped to
  // this async context (AsyncLocalStorage) so unrelated top-level moves in the
  // same process are not silently skipped.
  const doPropagate = async () => {
    // Lazy import: this module is imported by the same door it calls back into.
    const { moveStatus } = await import("./move-status.js");

    for (const link of links) {
      const targetStatus = targetStatusFor(link.config, newStatus);
      try {
        if (link.targetEntityId === sourceEntityId) {
          result.skipped.push({
            targetEntityId: link.targetEntityId,
            reason: "target is the source — self-link ignored",
          });
          continue;
        }
        const [row] = await db
          .select({ id: entities.id, deletedAt: entities.deletedAt })
          .from(entities)
          .where(eq(entities.id, link.targetEntityId))
          .limit(1);
        if (!row || row.deletedAt) {
          result.skipped.push({
            targetEntityId: link.targetEntityId,
            reason: "target entity not found or deleted",
          });
          continue;
        }
        const moved = await moveStatus({
          entityId: link.targetEntityId,
          to: targetStatus,
          actor: context.actor,
          sessionId: context.sessionId ?? null,
          workspaceId: context.workspaceId ?? null,
          reason:
            context.reason ?? `Status "${newStatus}" propagated from ${sourceEntityId}`,
        });
        if (moved.status === "moved" || moved.status === "unchanged") {
          result.propagated.push({
            targetEntityId: link.targetEntityId,
            sourceStatus: newStatus,
            targetStatus,
          });
        } else {
          result.skipped.push({
            targetEntityId: link.targetEntityId,
            reason:
              "reason" in moved
                ? moved.reason
                : moved.status === "conflict"
                  ? `conflict: actual ${moved.actual ?? "none"}`
                  : moved.status,
          });
        }
      } catch (err) {
        logger.warn(
          { err, sourceEntityId, targetEntityId: link.targetEntityId },
          "status-link propagation failed"
        );
        result.skipped.push({
          targetEntityId: link.targetEntityId,
          reason: err instanceof Error ? err.message : "propagation error",
        });
      }
    }
    return result;
  };

  return withPropagationScope(doPropagate);
}
