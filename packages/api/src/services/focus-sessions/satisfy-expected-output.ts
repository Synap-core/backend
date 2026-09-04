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
}

export interface SatisfyExpectedOutputsResult {
  /** Labels of the outputs newly stamped done (empty ⇒ nothing matched). */
  satisfied: string[];
}

/**
 * Stamp the FIRST not-yet-done expected output whose kind matches the approved
 * proposal's target. First-only on purpose: two declared "document" outputs are
 * two deliverables, and one approval is evidence for exactly one of them.
 *
 * Best-effort by contract — the caller (proposal approval) must never fail
 * because a provenance stamp could not be written. Returns `satisfied: []` when
 * the session is gone, carries no outputs, or nothing matched.
 */
export async function satisfyExpectedOutputs(
  params: SatisfyExpectedOutputsParams
): Promise<SatisfyExpectedOutputsResult> {
  const { sessionId, targetType, proposalId } = params;

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

    const index = selectOutputToSatisfy(current, targetType);
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
 * Which output this approval satisfies — the FIRST not-yet-done one whose kind
 * normalizes to the proposal's target kind, or `-1`. Pure, so the matching rule
 * is testable without a database (the transaction around it is not the logic).
 *
 * First-only on purpose: two declared "document" outputs are two deliverables,
 * and one approval is evidence for exactly one of them.
 */
export function selectOutputToSatisfy(
  outputs: ExpectedOutput[],
  targetType: string | null | undefined
): number {
  const kind = normalizeObjectKind(targetType);
  return outputs.findIndex(
    (o) => o.status !== "done" && normalizeObjectKind(o.kind) === kind
  );
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
