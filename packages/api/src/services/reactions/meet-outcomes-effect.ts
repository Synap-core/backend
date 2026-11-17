/**
 * The `meet_outcomes` effect of the reactions reactor (plan 7d71ddcc W2, pod
 * default 3, "an outcome is met wherever it was filed"): a proposal moved to
 * approved or auto_approved → every outcome, in ANY session of the proposal's
 * owner, whose own `ref` names what it approved → met through THE done door
 * (`satisfyOutputsByRef`, `satisfy-expected-output.ts`), with the reaction's
 * `cause` on each slot's transition.
 *
 * Its door lives here, in @synap/api, so apps/api fills the effect's slot in
 * @synap/jobs at boot (`registerReactionEffect`). A pull request merge, the
 * default's other trigger, is not a transition: the merge sweeper applies it
 * (`dev-loop/merge-sweeper.ts`), under the same rule's enabled flag.
 */
import {
  and,
  db,
  drizzleSql,
  eq,
  focusSessions,
  proposals,
} from "@synap/database";
import type {
  ReactionEffect,
  ReactionEffectOutcome,
} from "@synap/jobs/utils/reaction-effects.js";
import type { PlannedWrite } from "@synap/jobs/utils/reactions.js";
import { readCriteria, type ExpectedOutput } from "@synap/playbooks";
import { slotStatusOf } from "@synap-core/types/units";
import {
  RECENTLY_CLOSED_MS,
  outcomeRefOfProposal,
  satisfyOutputsByRef,
  selectSlotsMetByRef,
  sessionMayBeMetByRef,
  type OutcomeRefTarget,
} from "../focus-sessions/satisfy-expected-output.js";
import { deriveSlotKeys } from "../focus-sessions/slot-keys.js";

/** Whose sessions an approval may meet outcomes in: the proposal's owner. */
async function proposalOwner(proposalId: string): Promise<string | null> {
  const [row] = await db
    .select({
      sessionOwner: focusSessions.userId,
      subjectUserId: proposals.subjectUserId,
      proposedByUserId: proposals.proposedByUserId,
    })
    .from(proposals)
    .leftJoin(focusSessions, eq(focusSessions.id, proposals.sessionId))
    .where(eq(proposals.id, proposalId))
    .limit(1);
  return (
    row?.sessionOwner ?? row?.subjectUserId ?? row?.proposedByUserId ?? null
  );
}

/** The owner's sessions with an outcome whose `ref` is this object. */
/**
 * The owner's sessions with an outcome whose `ref` is this object, bounded in
 * SQL by the same scope the door applies (`sessionMayBeMetByRef`: not
 * cancelled or failed; closed only within the approval window), so an
 * approval never scans the owner's whole history. The id is matched in any
 * case, as `slotRefIs` does (the JSON text is lowered on both sides).
 */
async function sessionsPointingAt(
  userId: string,
  ref: OutcomeRefTarget,
  now: Date
) {
  const wanted = JSON.stringify([
    { ref: { kind: ref.kind, id: ref.id } },
  ]).toLowerCase();
  const closedSince = new Date(now.getTime() - RECENTLY_CLOSED_MS);
  return db
    .select({
      id: focusSessions.id,
      status: focusSessions.status,
      closedAt: focusSessions.closedAt,
      expectedOutputs: focusSessions.expectedOutputs,
      criteria: focusSessions.criteria,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, userId),
        drizzleSql`${focusSessions.status} NOT IN ('cancelled', 'failed')`,
        drizzleSql`(${focusSessions.status} <> 'closed' OR ${focusSessions.closedAt} > ${closedSince.toISOString()}::timestamptz)`,
        drizzleSql`lower(${focusSessions.expectedOutputs}::text)::jsonb @> ${wanted}::jsonb`
      )
    );
}

export const meetOutcomesReactionEffect: ReactionEffect = {
  key: "meet_outcomes",
  async plan(t) {
    if (t.subjectType !== "proposal") return [];
    const ref = outcomeRefOfProposal(t);
    if (!ref) return [];
    const owner = await proposalOwner(t.subjectId);
    if (!owner) return [];
    const now = new Date();
    const writes: PlannedWrite[] = [];
    for (const s of await sessionsPointingAt(owner, ref, now)) {
      if (!sessionMayBeMetByRef(s, now)) continue;
      const slots: ExpectedOutput[] = Array.isArray(s.expectedOutputs)
        ? (s.expectedOutputs as ExpectedOutput[])
        : [];
      const criterionKeys = new Set(readCriteria(s.criteria).map((c) => c.key));
      for (const pick of selectSlotsMetByRef(slots, ref, criterionKeys)) {
        const label = slots[pick.index]!.label || pick.key;
        writes.push({
          target: { subjectType: "slot", subjectId: `${s.id}/${pick.key}` },
          to: "done",
          toCategory: "done",
          expectedFrom: slotStatusOf(slots[pick.index]!),
          ownerUserId: owner,
          detail: {
            sessionId: s.id,
            slotKey: pick.key,
            ref,
            proposalId: t.subjectId,
          },
          say: {
            name: label,
            applied: `Met \u201c${label}\u201d: what it points at was approved.`,
          },
        });
      }
    }
    return writes;
  },
  async apply(write, ctx): Promise<ReactionEffectOutcome> {
    const d = write.detail as {
      sessionId: string;
      slotKey: string;
      ref: OutcomeRefTarget;
      proposalId: string;
    };
    const r = await satisfyOutputsByRef({
      sessionId: d.sessionId,
      userId: write.ownerUserId,
      ref: d.ref,
      proposalId: d.proposalId,
      slotKey: d.slotKey,
      cause: ctx.cause,
    });
    if (r.satisfied.some((s) => s.key === d.slotKey)) {
      return { status: "applied", transitionIds: [] };
    }
    // Not met now: already met (nothing to do), or it changed since the
    // plan read it (withdrawn, handed to the person) — a person's move wins.
    const [row] = await db
      .select({ expectedOutputs: focusSessions.expectedOutputs })
      .from(focusSessions)
      .where(eq(focusSessions.id, d.sessionId))
      .limit(1);
    const slots: ExpectedOutput[] = Array.isArray(row?.expectedOutputs)
      ? (row!.expectedOutputs as ExpectedOutput[])
      : [];
    const keys = deriveSlotKeys(slots);
    const slot = slots[keys.indexOf(d.slotKey)];
    if (slot && slotStatusOf(slot) === "done") return { status: "unchanged" };
    return {
      status: "moved_meanwhile",
      detail:
        "slot no longer pending for an agent (withdrawn, the person's, or gone)",
    };
  },
};
