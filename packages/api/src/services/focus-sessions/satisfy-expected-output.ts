/**
 * satisfyExpectedOutputs — the ONE door that stamps `status: "done"` onto a
 * focus session's `expectedOutputs`.
 *
 * WHY a door at all: `expectedOutputs[]` is untyped JSONB that, until now, the
 * AGENT marked done itself (`focusSessions.update`'s `completeOutput`, matched
 * by LABEL). An agent grading its own homework is not a signal — the session
 * then closed "clean" with warn-only noise and nobody could tell a delivered
 * deliverable from a claimed one.
 *
 * The honest signal is APPROVAL. A proposal carries `sessionId` (P1 attributes
 * both auto-approved and proposed agent writes to their session), so when such a
 * proposal is APPROVED and applied, a human (or an explicit governance rule) has
 * accepted the artefact. That — and only that — stamps `done`, together with
 * `satisfiedByProposalId` lineage so the stamp is falsifiable after the fact.
 *
 * The agent's own mark writes `claimedDone: true` instead (see
 * `update-session.ts`), which the session-completion warning reads to say
 * "claimed but not satisfied" rather than silently accepting the claim.
 *
 * Matching is by KIND, via the vocabulary's `normalizeObjectKind` — the SAME
 * targetType→object-kind normalization the render + governance layers use
 * (`@synap-core/types/vocabulary`). No second mapping table exists or should.
 *
 * A proposal may additionally carry a SLOT CLAIM (`proposals.data.expectedLabel`,
 * written by `checkPermissionOrPropose` when the change's own name matches a
 * declared slot label exactly). When present it outranks the FIRST-OF-KIND guess
 * — the SAME precedence `session-outputs.ts` already gives
 * `artifacts.props.expectedLabel` (rule 3 there) — but never the kind itself: a
 * claimed slot must still be of the kind that was produced. It is a CLAIM about
 * WHICH deliverable this is, never a `done` stamp: approval is still what stamps,
 * and an unmatched claim falls back to the kind guess rather than satisfying
 * nothing.
 */

import { db, focusSessions, eq } from "@synap/database";
import { normalizeObjectKind } from "@synap-core/types/vocabulary";
import type { ExpectedOutput } from "@synap/playbooks";

/** How long after close an approval still counts as satisfying this session. */
const RECENTLY_CLOSED_MS = 24 * 60 * 60 * 1000;

export interface SatisfyExpectedOutputsParams {
  sessionId: string;
  /** The proposal's `targetType` (e.g. `entity`, `document`, `focus_session`). */
  targetType: string | null | undefined;
  /** Lineage stamped onto every output this call satisfies. */
  proposalId: string;
  /**
   * The slot CLAIM carried by the proposal (`proposals.data.expectedLabel`).
   * Read with `readProposalExpectedLabel` at both approval call sites. Optional:
   * absent ⇒ today's kind-only behaviour, unchanged.
   */
  expectedLabel?: string | null;
}

export interface SatisfyExpectedOutputsResult {
  /** Labels of the outputs newly stamped done (empty ⇒ nothing matched). */
  satisfied: string[];
}

/**
 * Stamp the ONE not-yet-done expected output this approval satisfies — the slot
 * the proposal CLAIMED by label, else the first of the matching kind (see
 * `selectOutputToSatisfy`). One approval is evidence for exactly one deliverable.
 *
 * Best-effort by contract — the caller (proposal approval) must never fail
 * because a provenance stamp could not be written. Returns `satisfied: []` when
 * the session is gone, carries no outputs, or nothing matched.
 */
export async function satisfyExpectedOutputs(
  params: SatisfyExpectedOutputsParams
): Promise<SatisfyExpectedOutputsResult> {
  const { sessionId, targetType, proposalId, expectedLabel } = params;

  return await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        expectedOutputs: focusSessions.expectedOutputs,
        status: focusSessions.status,
        closedAt: focusSessions.closedAt,
      })
      .from(focusSessions)
      .where(eq(focusSessions.id, sessionId))
      .for("update");
    if (!locked) return { satisfied: [] };

    // Open, or closed recently enough that this approval is plausibly the
    // review of work the session did. An approval landing days after the
    // session closed is not evidence about that session's deliverables.
    const closedAgeMs = locked.closedAt
      ? Date.now() - new Date(locked.closedAt).getTime()
      : 0;
    const inScope =
      locked.status !== "closed" || closedAgeMs <= RECENTLY_CLOSED_MS;
    if (!inScope) return { satisfied: [] };

    const current: ExpectedOutput[] = Array.isArray(locked?.expectedOutputs)
      ? (locked.expectedOutputs as ExpectedOutput[])
      : [];
    if (current.length === 0) return { satisfied: [] };

    const index = selectOutputToSatisfy(current, targetType, expectedLabel);
    if (index === -1) return { satisfied: [] };

    const next = stampSatisfied(current, index, proposalId);

    await tx
      .update(focusSessions)
      .set({ expectedOutputs: next, updatedAt: new Date() })
      .where(eq(focusSessions.id, sessionId));

    return { satisfied: [current[index]!.label] };
  });
}

/**
 * Which output this approval satisfies, or `-1`. Pure, so the matching rule is
 * testable without a database (the transaction around it is not the logic).
 *
 * TWO rungs, in this order:
 *
 *   1. SLOT CLAIM — the not-yet-done output whose `label` equals `expectedLabel`
 *      exactly (trimmed, case-insensitive) AND whose declared kind normalizes to
 *      the same object kind as the change. The claim names WHICH deliverable the
 *      change is for, so it beats the first-of-kind guess — but it does not
 *      outrank the kind itself. A label match on a slot of a DIFFERENT kind is
 *      not evidence that this change is that deliverable: an entity titled the
 *      same as a declared document slot would otherwise stamp the document done,
 *      and the session would report a deliverable nobody produced. On a kind
 *      mismatch the claim is dropped and rung 2 decides.
 *   2. KIND — the FIRST not-yet-done output whose kind normalizes to the
 *      proposal's target kind, SKIPPING any slot the agent declared the human
 *      owns. First-only on purpose: two declared "document" outputs are two
 *      deliverables, and one approval is evidence for exactly one of them.
 *
 *      The `owner: 'human'` skip is what makes rung 2 a guess that cannot lie.
 *      Governance already refuses to let an agent CLAIM a human-owned slot
 *      (`resolveSessionSlotClaim`), but without this the refusal bought nothing:
 *      with no claim the approval fell straight through to this rung and stamped
 *      that very slot `done` anyway — the agent closing work it had itself
 *      declared it could not do, with lineage that made it look verified. A
 *      guess may not land on a deliverable nobody claims to have produced.
 *      Rung 1 is deliberately NOT floored the same way: an explicit claim is
 *      evidence, and one naming a human-owned slot can only have come from a
 *      path that meant it.
 *
 * A claim that matches nothing (unknown label, or a label whose slot is already
 * done) falls THROUGH to rung 2 rather than returning `-1` — an approval is
 * still evidence about this session even when the claim is stale.
 */
export function selectOutputToSatisfy(
  outputs: ExpectedOutput[],
  targetType: string | null | undefined,
  expectedLabel?: string | null
): number {
  const kind = normalizeObjectKind(targetType);

  const claim = normalizeLabel(expectedLabel);
  if (claim) {
    const claimed = outputs.findIndex(
      (o) =>
        o.status !== "done" &&
        normalizeLabel(o.label) === claim &&
        normalizeObjectKind(o.kind) === kind
    );
    if (claimed !== -1) return claimed;
  }

  return outputs.findIndex(
    (o) =>
      o.status !== "done" &&
      o.owner !== "human" &&
      normalizeObjectKind(o.kind) === kind
  );
}

/**
 * Trim + casefold — the ONE comparison used on both sides of a label match.
 *
 * Exported because THREE places now compare a caller-supplied label to a
 * declared slot label: this selector, the delegation door
 * (`delegate-output.ts`) and the rejection return (`return-delegated-slot.ts`).
 * A second casefold rule would be a second answer to "is this the same slot",
 * which is exactly the fork the vocabulary rules forbid.
 */
export function normalizeExpectedLabel(
  label: string | null | undefined
): string | undefined {
  return normalizeLabel(label);
}

function normalizeLabel(label: string | null | undefined): string | undefined {
  if (typeof label !== "string") return undefined;
  const trimmed = label.trim().toLowerCase();
  return trimmed || undefined;
}

/**
 * Read the slot CLAIM off a proposal's stored `data`. The ONE reader, so the two
 * approval call sites cannot disagree about where the label lives.
 *
 * The claim sits at the TOP LEVEL of `proposals.data` — beside the
 * request-shaped envelope, never inside its nested `data`, which is the gate
 * payload the executors parse.
 */
export function readProposalExpectedLabel(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = (data as { expectedLabel?: unknown }).expectedLabel;
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * The stamp itself — status + lineage, every other output untouched. The ONLY
 * place in the codebase that may write `status: "done"` onto an expected output
 * (pinned by `expected-output-done-one-door.test.ts`).
 */
export function stampSatisfied(
  outputs: ExpectedOutput[],
  index: number,
  proposalId: string
): ExpectedOutput[] {
  return outputs.map((o, i) =>
    i === index
      ? { ...o, status: "done" as const, satisfiedByProposalId: proposalId }
      : o
  );
}
