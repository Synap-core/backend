/**
 * The `reach_stage_status` effect of the reactions reactor — decision D2's
 * approval signal 1 as ONE built-in rule (`builtin:approved-output-reaches-
 * status`, `@synap/jobs` reactions), not a second path beside the reactor
 * (decision D1, code review 6bf3101d M2): a slot moved to done (or a deciding
 * answer) → the stage of its session that declares it, when every output that
 * stage owes is now delivered → the session's subject moves to the stage's
 * `onApproved`, through THE status door (`moveStatus`, via
 * `writeStageReachedStatus`), with the reaction's `cause`.
 *
 * Whichever door delivered the slot owes its transition (reactions W1): the
 * approval tail, auto-approve, attest, answer, evidence, a recorded merge, a
 * child run, and default 3 meeting it by its ref (M2b) — so every one of them
 * reaches the stage here, and none calls the writer itself.
 *
 * WHO MOVES IT (D6, founder default c). A reaction moves as the `system`, on
 * the person's own rule — except where only a person's say may move the
 * thing:
 *  - a `humanOnly` value: written AS THE APPROVING PERSON when a person
 *    approved the work (their approval is that say; a second proposal would
 *    ask them twice), and proposed through the door's own governance when no
 *    person did (an agent's evidence, a merge);
 *  - a move into done or lost (D3, the reactor's guard plans it `propose`):
 *    the same split — a person's approval writes it as them, anything else is
 *    filed as a proposal by the door.
 * The `system` cannot carry either case: the status door skips governance for
 * it, so a `system` write of a humanOnly or closing value would move the
 * thing without anyone's say. That is why those two cases keep an explicit
 * actor (the approver) instead of the reaction's.
 *
 * Its door lives in @synap/api, so apps/api fills the effect's slot in
 * @synap/jobs at boot (`registerReactionEffect`), like `meet_outcomes`.
 */
import { db, eq, proposals, users } from "@synap/database";
import type {
  ReactionEffect,
  ReactionEffectContext,
  ReactionEffectOutcome,
} from "@synap/jobs/utils/reaction-effects.js";
import type { PlannedWrite } from "@synap/jobs/utils/reactions.js";
import type { AnyTransitionPayload } from "@synap-core/types/lifecycle";
import {
  approverActor,
  readReachedMoveTarget,
  stagesApprovedBySettledSlots,
  writeStageReachedStatus,
  type StageApprover,
  type StageSubjectStatusOutcome,
} from "../focus-sessions/stage-subject-status.js";

/** What a planned reach carries from the plan to the write. */
interface ReachDetail {
  session: {
    id: string;
    playbookId: string | null;
    subjectEntityId: string;
    workspaceId: string | null;
  };
  stageKey: string;
  approver: StageApprover;
  humanOnly: boolean;
}

/**
 * Who approved the work the slot's move records: a PERSON when a person made
 * the move (attested it, answered it) or approved the proposal that delivered
 * it; otherwise the agent the delivery is attributed to (an auto-approved
 * write, evidence, a merge, a child run), on the owner's behalf.
 */
async function approverOf(
  t: AnyTransitionPayload,
  ownerUserId: string
): Promise<StageApprover> {
  if (t.actorKind === "human") return { kind: "person", userId: t.userId };
  if (t.proposalId) {
    const [p] = await db
      .select({
        status: proposals.status,
        reviewedBy: proposals.reviewedBy,
        agentUserId: proposals.agentUserId,
      })
      .from(proposals)
      .where(eq(proposals.id, t.proposalId))
      .limit(1);
    if (p?.status === "approved" && p.reviewedBy) {
      const [reviewer] = await db
        .select({ userType: users.userType })
        .from(users)
        .where(eq(users.id, p.reviewedBy))
        .limit(1);
      if (reviewer?.userType === "human") {
        return { kind: "person", userId: p.reviewedBy };
      }
    }
    return {
      kind: "agent",
      userId: ownerUserId,
      agentUserId: p?.agentUserId ?? t.agentUserId ?? null,
    };
  }
  return { kind: "agent", userId: ownerUserId, agentUserId: t.agentUserId };
}

function toEffectOutcome(
  out: StageSubjectStatusOutcome
): ReactionEffectOutcome {
  switch (out.status) {
    case "written":
      return { status: "applied", transitionIds: [] };
    case "proposed":
      return { status: "proposed", proposalId: out.proposalId };
    case "skipped":
      // already_set, or the subject is already past the stage: nothing to do.
      return out.reason === "already_set" || out.reason === "subject_ahead"
        ? { status: "unchanged" }
        : { status: "refused", detail: out.reason };
    case "failed":
      return out.code === "moved_meanwhile"
        ? { status: "moved_meanwhile", detail: out.reason }
        : { status: "refused", detail: out.reason };
  }
}

/** The writer's input for one planned reach, and who moves it. */
function reachInput(
  write: PlannedWrite,
  ctx: ReactionEffectContext,
  /** The reactor's guard planned a closing move (D3): never as the system. */
  closing: boolean
): Parameters<typeof writeStageReachedStatus>[0] {
  const d = write.detail as unknown as ReachDetail;
  return {
    session: d.session,
    stageKey: d.stageKey,
    signal: "output_approved",
    approver: d.approver,
    actor:
      closing || d.humanOnly
        ? approverActor(d.approver)
        : { kind: "system", userId: write.ownerUserId },
    cause: ctx.cause,
    expectedFrom: write.expectedFrom,
  };
}

export const reachStageStatusReactionEffect: ReactionEffect = {
  key: "reach_stage_status",
  async plan(t) {
    if (t.subjectType !== "slot" || !t.sessionId) return [];
    const slotKey = (t as { slotKey?: unknown }).slotKey;
    if (typeof slotKey !== "string" || !slotKey) return [];
    const approved = await stagesApprovedBySettledSlots({
      sessionId: t.sessionId,
      settled: [{ key: slotKey, label: slotKey }],
    });
    if (!approved || approved.stages.length === 0) return [];
    const { session } = approved;
    const approver = await approverOf(t, session.userId);
    // ONE write per subject: the reactor's guard reads two values for one
    // target as a conflict. The LATEST approved stage the subject does not
    // hold yet is where the work stands (an earlier one is behind it, and the
    // writer never moves a subject back).
    for (const { stageKey, stageName, value } of [
      ...approved.stages,
    ].reverse()) {
      const target = await readReachedMoveTarget({
        session,
        subjectEntityId: session.subjectEntityId,
        value,
      });
      if (!target) continue;
      if (target.current === value) return [];
      const detail: ReachDetail = {
        session: {
          id: session.id,
          playbookId: session.playbookId,
          subjectEntityId: session.subjectEntityId,
          workspaceId: session.workspaceId,
        },
        stageKey,
        approver,
        humanOnly: target.humanOnly,
      };
      return [
        {
          target: {
            subjectType: "entity",
            subjectId: session.subjectEntityId,
          },
          to: value,
          toCategory: target.category,
          expectedFrom: target.current,
          ownerUserId: session.userId,
          detail: detail as unknown as Record<string, unknown>,
          say: {
            name: target.title,
            applied: `Moved \u201c${target.title}\u201d to ${target.label}: the work of \u201c${stageName}\u201d was approved.`,
          },
        },
      ];
    }
    return [];
  },
  async apply(write, ctx) {
    return toEffectOutcome(
      await writeStageReachedStatus(reachInput(write, ctx, false))
    );
  },
  async propose(write, ctx) {
    return toEffectOutcome(
      await writeStageReachedStatus(reachInput(write, ctx, true))
    );
  },
};
