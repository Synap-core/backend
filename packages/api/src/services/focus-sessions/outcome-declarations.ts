/**
 * `outcomes[]` — the ONE external declaration of what a session must yield
 * (A4 of the outcome model). An ALIAS over today's storage, never a third
 * store: each outcome is written where the read-time projection
 * (`projectSessionOutcomes`, `@synap-core/types/units`) already reads it.
 *
 *   kind "fact"           → a CRITERION (`focus_sessions.criteria`) — an
 *                           outcome whose thing is a fact, checked by `verify`
 *                           (default `judge`).
 *   any other kind        → a deliverable SLOT (`expected_outputs`) under the
 *                           outcome's key. Checked by EVIDENCE by default (the
 *                           agent claims it, a produced object or its `ref`
 *                           proves it — `satisfyClaimsByEvidence`); by the
 *                           person when `owner: "human"`.
 *   + `verify` judge/capability/human, or evidence with an `evidenceKey`, on a
 *     deliverable → ALSO a criterion under the SAME key. The projection folds a
 *     slot and a criterion sharing a key into ONE outcome (rule 7), and the
 *     evidence verdict then leaves the slot to that criterion's evaluator.
 *
 * `expectedOutputs` / `criteria` / `addOutput` / `completeOutput` stay as
 * DEPRECATED aliases over the same storage — every door keeps accepting them.
 * Inputs (what the work needs from the person) are not declared here: they are
 * derived — a param the playbook asks for, a slot handed over with
 * `owner: "human"` + `blockedReason`, an escalated criterion.
 *
 * PURE except {@link resolveOutcomesUpdate}, which reads the stored row so an
 * update UPSERTS by key instead of replacing the lists wholesale.
 */

import { z } from "zod";
import { slotKeyBase } from "@synap-core/types/units";
import { db, focusSessions, eq, and } from "@synap/database";
import {
  BLOCKED_REASONS,
  CRITERION_CHECK_KINDS,
  readCriteria,
  type CriterionCheckKind,
  type ExpectedOutput,
  type SessionCriterion,
} from "@synap/playbooks";
import { expectedOutputWireSchema } from "./update-session.js";
import { DECLARED_SLOT_KEY_RE, findSlotIndex } from "./slot-keys.js";

/** The kind that makes an outcome a FACT (a criterion), not a deliverable. */
export const FACT_OUTCOME_KIND = "fact";

export const outcomeDeclarationSchema = z
  .object({
    key: z
      .string()
      .regex(DECLARED_SLOT_KEY_RE, "key must be a lowercase slug (a-z, 0-9, -)")
      .optional(),
    label: z.string().trim().min(1).max(500),
    kind: z.string().trim().min(1).max(80).optional(),
    icon: z.string().optional(),
    verify: z
      .object({
        kind: z.enum(
          CRITERION_CHECK_KINDS as readonly [
            CriterionCheckKind,
            ...CriterionCheckKind[],
          ]
        ),
        capability: z.string().min(1).max(200).optional(),
        evidenceKey: z.string().min(1).max(80).optional(),
        hint: z.string().max(1000).optional(),
      })
      .optional(),
    required: z.boolean().optional(),
    owner: z.enum(["human", "agent"]).optional(),
    blockedReason: z.enum(BLOCKED_REASONS).optional(),
    why: z.string().max(500).optional(),
    // The same wire shapes the slot doors parse — one schema per field.
    ref: expectedOutputWireSchema.shape.ref,
    ask: expectedOutputWireSchema.shape.ask,
  })
  .strict();

export type OutcomeDeclaration = z.infer<typeof outcomeDeclarationSchema>;

export const outcomeDeclarationsSchema = z
  .array(outcomeDeclarationSchema)
  .max(40);

/** The key an outcome is stored under — its declared key, else its label's slug. */
export function outcomeKeyOf(o: OutcomeDeclaration): string {
  return o.key ?? slotKeyBase(o.label);
}

/** Does a deliverable's `verify` name a check beyond its own evidence? */
function needsCriterion(o: OutcomeDeclaration): boolean {
  if (!o.verify) return false;
  return o.verify.kind !== "evidence" || !!o.verify.evidenceKey;
}

function criterionOf(o: OutcomeDeclaration): SessionCriterion {
  const verify = o.verify ?? { kind: "judge" as const };
  return {
    key: outcomeKeyOf(o),
    statement: o.label,
    ...(o.required !== undefined ? { required: o.required } : {}),
    check: {
      kind: verify.kind,
      ...(verify.capability ? { capability: verify.capability } : {}),
      ...(verify.evidenceKey ? { evidenceKey: verify.evidenceKey } : {}),
      ...(verify.hint ? { hint: verify.hint } : {}),
    },
  };
}

function slotOf(o: OutcomeDeclaration): ExpectedOutput {
  return {
    kind: o.kind ?? "output",
    label: o.label,
    key: outcomeKeyOf(o),
    ...(o.icon ? { icon: o.icon } : {}),
    ...(o.owner ? { owner: o.owner } : {}),
    ...(o.blockedReason ? { blockedReason: o.blockedReason } : {}),
    ...(o.why ? { why: o.why } : {}),
    ...(o.ref ? { ref: o.ref } : {}),
    ...(o.ask ? { ask: o.ask } : {}),
  };
}

/** Outcomes → the two stores they live in. Pure. */
export function splitOutcomes(outcomes: readonly OutcomeDeclaration[]): {
  expectedOutputs: ExpectedOutput[];
  criteria: SessionCriterion[];
} {
  const expectedOutputs: ExpectedOutput[] = [];
  const criteria: SessionCriterion[] = [];
  for (const o of outcomes) {
    if ((o.kind ?? "").toLowerCase() === FACT_OUTCOME_KIND) {
      criteria.push(criterionOf(o));
      continue;
    }
    expectedOutputs.push(slotOf(o));
    if (needsCriterion(o)) criteria.push(criterionOf(o));
  }
  return { expectedOutputs, criteria };
}

/**
 * START: the outcomes APPENDED to whatever the caller also declared through
 * the deprecated fields (those first — they were said first). Pure.
 */
export function mergeOutcomesForStart(p: {
  outcomes: readonly OutcomeDeclaration[];
  expectedOutputs?: ExpectedOutput[];
  criteria?: SessionCriterion[];
}): { expectedOutputs?: ExpectedOutput[]; criteria?: SessionCriterion[] } {
  const split = splitOutcomes(p.outcomes);
  const expectedOutputs = [
    ...(p.expectedOutputs ?? []),
    ...split.expectedOutputs,
  ];
  const criteria = [...(p.criteria ?? []), ...split.criteria];
  return {
    ...(expectedOutputs.length > 0 ? { expectedOutputs } : {}),
    ...(criteria.length > 0 ? { criteria } : {}),
  };
}

/**
 * UPDATE: the outcomes UPSERTED by key onto the current lists. Pure.
 *
 * A deliverable matching a stored slot (by key, then label — `findSlotIndex`)
 * keeps the stored object and takes only what an outcome DECLARES (label,
 * kind, icon, owner, blocker, why, ref, ask): every receipt rides through
 * untouched, so the wholesale merge sees a round-trip, never a forgery. A
 * new one is appended. Criteria upsert by key the same way. Nothing the
 * outcomes do not name is removed — an upsert, not a replace.
 */
export function upsertOutcomes(
  current: { expectedOutputs: ExpectedOutput[]; criteria: SessionCriterion[] },
  outcomes: readonly OutcomeDeclaration[]
): { expectedOutputs: ExpectedOutput[]; criteria: SessionCriterion[] } {
  const split = splitOutcomes(outcomes);
  const expectedOutputs = [...current.expectedOutputs];
  for (const slot of split.expectedOutputs) {
    const at = findSlotIndex(expectedOutputs, {
      key: slot.key,
      label: slot.label,
    });
    if (at === -1) {
      expectedOutputs.push(slot);
      continue;
    }
    const { key: _declared, ...declared } = slot;
    expectedOutputs[at] = { ...expectedOutputs[at]!, ...declared };
  }
  const criteria = [...current.criteria];
  for (const c of split.criteria) {
    const at = criteria.findIndex((x) => x.key === c.key);
    if (at === -1) criteria.push(c);
    else criteria[at] = { ...criteria[at]!, ...c };
  }
  return { expectedOutputs, criteria };
}

/**
 * The update patch an `outcomes` list stands for, against the STORED row
 * (owner-floored) — or the caller's own wholesale lists when the same call
 * sent them. `null` when the session is not the caller's.
 *
 * The read is unlocked; the write it feeds goes through the row-locked merge,
 * which carries every receipt and refuses a forged one — the same contract a
 * wholesale `expectedOutputs` patch already has.
 */
export async function resolveOutcomesUpdate(p: {
  sessionId: string;
  userId: string;
  outcomes: readonly OutcomeDeclaration[];
  expectedOutputs?: ExpectedOutput[];
  criteria?: SessionCriterion[];
}): Promise<{
  expectedOutputs: ExpectedOutput[];
  criteria: SessionCriterion[];
} | null> {
  const row = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, p.sessionId),
      eq(focusSessions.userId, p.userId)
    ),
    columns: { expectedOutputs: true, criteria: true },
  });
  if (!row) return null;
  const stored = Array.isArray(row.expectedOutputs)
    ? (row.expectedOutputs as ExpectedOutput[])
    : [];
  return upsertOutcomes(
    {
      expectedOutputs: p.expectedOutputs ?? stored,
      criteria: p.criteria ?? readCriteria(row.criteria),
    },
    p.outcomes
  );
}
