/**
 * The `roll_up` effect of the reactions reactor (plan 7d71ddcc W3, pod
 * default 1, "roll up along `part_of`"): a thing moved into done or lost →
 * every parent a declared relation links it to → when every NON-lost part of
 * that parent is done and at least one is (decision D5), the parent moves to
 * the declared status (else its next one) through THE thing's door
 * (`moveStatus`), as the `system`, with the reaction's `cause`.
 *
 *   - Every level works: the parent's move is itself a transition, which
 *     rolls up its own parent when the declaration chains (`chains: true`),
 *     down to the reactor's depth cap.
 *   - A person's move wins: the write is a compare-and-set from the status
 *     the plan read (`expectedFrom`), and a miss is skipped `moved_meanwhile`.
 *   - D3: a move into done or lost is PROPOSED (`propose`, the pod files an
 *     `entity/transition` for the parent's owner) unless the declaration
 *     opts out (`terminal: "apply"`). Its approval replays the move with the
 *     same `cause` (`executors/entity-transition.ts`).
 *
 * The parts are read by THE parts reader (`readPartsRollups`, beside the
 * other roll-ups in `status-rollup.ts`), which `statusOf`'s "3 of 5 done"
 * reads too. The decision itself is pure (`rollupProgress`,
 * `@synap-core/types/relations`).
 *
 * Its door lives here, in @synap/api, so apps/api fills the effect's slot in
 * @synap/jobs at boot (`registerReactionEffect`).
 */
import {
  and,
  db,
  entities,
  eq,
  isNull,
  relations,
  resolveStatusMoveTarget,
} from "@synap/database";
import { findLifecycleOption } from "@synap-core/types/lifecycle";
import { rollupTarget } from "@synap-core/types/relations";
import type {
  ReactionEffect,
  ReactionEffectOutcome,
} from "@synap/jobs/utils/reaction-effects.js";
import type {
  PlannedWrite,
  ReactionDeclaration,
} from "@synap/jobs/utils/reactions.js";
import { moveStatus, type MoveStatusResult } from "../lifecycle/move-status.js";
import { readPartsRollups } from "../status/status-rollup.js";

/** The pod's mark on a proposal a reaction filed (`proposals.created_by`). */
export const REACTION_PROPOSAL_AUTHOR = "system:reactions" as const;

type RelationVia = Extract<ReactionDeclaration["via"], { link: "relation" }>;

function relationOf(r: ReactionDeclaration): RelationVia | null {
  return r.via.link === "relation" ? r.via : null;
}

/** The parents the moved thing is a part of, through the declared pair. */
async function parentsOf(childId: string, via: RelationVia) {
  const childCol =
    via.parent === "target"
      ? relations.sourceEntityId
      : relations.targetEntityId;
  const parentCol =
    via.parent === "target"
      ? relations.targetEntityId
      : relations.sourceEntityId;
  const parentProfile =
    via.parent === "target" ? via.targetProfileId : via.sourceProfileId;
  return db
    .selectDistinct({
      id: entities.id,
      userId: entities.userId,
      workspaceId: entities.workspaceId,
    })
    .from(relations)
    .innerJoin(entities, eq(entities.id, parentCol))
    .where(
      and(
        eq(relations.type, via.relation),
        eq(childCol, childId),
        eq(entities.profileId, parentProfile),
        isNull(entities.deletedAt)
      )
    );
}

/** What the door said → the reactor's outcome. A refusal is never thrown. */
function outcomeOf(
  r: MoveStatusResult,
  write: PlannedWrite
): ReactionEffectOutcome {
  switch (r.status) {
    case "moved":
      return { status: "applied", transitionIds: [r.transition.transitionId] };
    case "unchanged":
      return { status: "unchanged" };
    case "conflict":
      return {
        status: "moved_meanwhile",
        reason: `It is no longer ${write.expectedFrom ?? "unset"}: it was moved to ${r.actual ?? "none"} meanwhile.`,
      };
    case "proposed":
      return { status: "proposed", proposalId: r.proposalId };
    case "denied":
      return { status: "refused", reason: r.reason };
    case "refused":
      return { status: "refused", reason: r.reason };
  }
}

export const rollUpReactionEffect: ReactionEffect = {
  key: "roll_up",
  async plan(t, reaction) {
    const via = relationOf(reaction);
    if (t.subjectType !== "entity" || !via) return [];
    if (reaction.do.effect !== "roll_up") return [];
    const declaredTo = reaction.do.to;
    const parents = await parentsOf(t.subjectId, via);
    if (parents.length === 0) return [];
    // The roll-up decides on EVERY part (server code: no reader floor).
    const parts = await readPartsRollups({
      parentIds: parents.map((p) => p.id),
      relation: via.relation,
      parentEnd: via.parent,
      viewer: null,
    });
    const writes: PlannedWrite[] = [];
    for (const parent of parents) {
      const progress = parts.get(parent.id)?.progress;
      if (!progress?.ready) continue;
      const resolved = await resolveStatusMoveTarget(db, {
        entityId: parent.id,
      });
      if (!resolved.ok) continue;
      const { target } = resolved;
      const to = rollupTarget({
        options: target.lifecycle.options,
        current: target.current,
        ...(declaredTo ? { to: declaredTo } : {}),
      });
      if (!to || to === target.current) continue;
      const toCategory = findLifecycleOption(target.lifecycle, to)?.category;
      if (!toCategory) continue;
      writes.push({
        target: { subjectType: "entity", subjectId: parent.id },
        to,
        toCategory,
        expectedFrom: target.current,
        ownerUserId: parent.userId,
        detail: {
          entityId: parent.id,
          workspaceId: parent.workspaceId,
          done: progress.done,
          of: progress.of,
          lost: progress.lost,
        },
      });
    }
    return writes;
  },
  async apply(write, ctx) {
    const d = write.detail as { entityId: string; workspaceId: string | null };
    const r = await moveStatus({
      entityId: d.entityId,
      expectedFrom: write.expectedFrom,
      to: write.to,
      actor: { kind: "system", userId: write.ownerUserId },
      reason: `"${ctx.reaction.title}": every part is done.`,
      workspaceId: d.workspaceId,
      cause: ctx.cause,
    });
    return outcomeOf(r, write);
  },
  async propose(write, ctx) {
    const d = write.detail as { entityId: string; workspaceId: string | null };
    const r = await moveStatus({
      entityId: d.entityId,
      expectedFrom: write.expectedFrom,
      to: write.to,
      actor: { kind: "system", userId: write.ownerUserId },
      reason: `"${ctx.reaction.title}": every part is done, so it can move to ${write.to}.`,
      workspaceId: d.workspaceId,
      cause: ctx.cause,
      proposeAs: REACTION_PROPOSAL_AUTHOR,
    });
    return outcomeOf(r, write);
  },
};
