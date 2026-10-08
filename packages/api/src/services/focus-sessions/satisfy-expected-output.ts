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
 * For an ENTITY change the kind is its PROFILE (`data.profileSlug`) when the
 * caller knows it — see `resolveChangeKind` — because `targetType` can only
 * ever say `entity` while slots are declared as `knowledge`, `task`, `person`.
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
 *
 * ── THE SECOND PATH: HUMAN ATTESTATION ──────────────────────────────────────
 * Everything above is about work an AGENT produced and a human accepted. A slot
 * the agent handed to the HUMAN (`owner: 'human'`, blockExpectedOutput) has no
 * artefact and no proposal — nobody can approve "I minted the Stripe key". Its
 * only honest close is the owner saying so, and `attestExpectedOutput` below is
 * that verb.
 *
 * It lives in THIS file, not a new one, because `status: "done"` has ONE write
 * door and that rule is pinned by a tripwire. A second stamper would be the
 * agent-grades-its-own-homework defect wearing a human's hat.
 *
 * ── THE THIRD PATH: EVIDENCE ────────────────────────────────────────────────
 * An agent's `completeOutput` is a CLAIM (`claimedDone`). When the claimed
 * slot also has evidence — a produced object the output join attributes to
 * it, or its declared `ref` — `satisfyClaimsByEvidence` (bottom of this file)
 * stamps `done` with `satisfiedByEvidence` lineage. Deterministic, no human
 * needed, and never for a person's slot or one a criterion checks.
 *
 * Three floors make it a different act from the approval path rather than a
 * bypass of it: only the slot's OWNER may attest, only on a slot whose `owner`
 * is `human`, and the stamp is `attestedBy`/`attestedAt` — never a fabricated
 * `satisfiedByProposalId`, which would make an attestation unfalsifiable by
 * dressing it as approval lineage.
 */

import { db, focusSessions, eq, and } from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { createLogger } from "@synap-core/core";
import { normalizeObjectKind } from "@synap-core/types/vocabulary";
import { askFingerprint, resolveAskResolution } from "@synap-core/types/ask";
import { CRITERION_SLOT_KIND } from "@synap-core/types/focus-sessions";
import { readCriteria, type ExpectedOutput } from "@synap/playbooks";
import { logEvent } from "../../lib/event-helpers.js";
import { normalizeExpectedLabel } from "./expected-label.js";
import { deriveSlotKeys, findSlotIndex } from "./slot-keys.js";
import { acceptDraftOnEngagement } from "./accept-on-engagement.js";
import { linkSatisfiedOutputsToSubject } from "./subject-edge.js";
import {
  FOCUS_SESSION_SUBJECT_TYPE,
  FOCUS_SESSION_SLOT_ATTEST_ACTION,
  FOCUS_SESSION_SLOT_ATTESTED_EVENT_TYPE,
} from "./lifecycle-events.js";

const attestLogger = createLogger({ module: "attest-slot" });

/** How long after close an approval still counts as satisfying this session. */
const RECENTLY_CLOSED_MS = 24 * 60 * 60 * 1000;

export interface SatisfyExpectedOutputsParams {
  sessionId: string;
  /** The proposal's `targetType` (e.g. `entity`, `document`, `focus_session`). */
  targetType: string | null | undefined;
  /**
   * The PROFILE of the entity the change produced (`data.profileSlug`), when
   * the target is an entity. `targetType` alone can only ever say `entity`,
   * while a slot is declared in the vocabulary the agent thinks in — `task`,
   * `knowledge`, `person`. Absent ⇒ the generic `entity` kind, exactly as
   * before. See `resolveChangeKind`.
   */
  entityProfileSlug?: string | null;
  /** Lineage stamped onto every output this call satisfies. */
  proposalId: string;
  /**
   * The slot CLAIM carried by the proposal (`proposals.data.expectedLabel`).
   * Read with `readProposalExpectedLabel` at both approval call sites. Optional:
   * absent ⇒ today's kind-only behaviour, unchanged.
   */
  expectedLabel?: string | null;
  /**
   * The same claim by slot KEY (`proposals.data.expectedKey`, read with
   * `readProposalExpectedKey`). Tried BEFORE the label; a proposal filed
   * before keys existed carries only the label, which still resolves.
   */
  expectedKey?: string | null;
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
  const {
    sessionId,
    targetType,
    proposalId,
    expectedLabel,
    expectedKey,
    entityProfileSlug,
  } = params;

  const result = await db.transaction(async (tx) => {
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

    const index = selectOutputToSatisfy(
      current,
      targetType,
      expectedLabel,
      entityProfileSlug,
      expectedKey
    );
    if (index === -1) return { satisfied: [] };

    const next = stampSatisfied(current, index, proposalId);

    await tx
      .update(focusSessions)
      .set({ expectedOutputs: next, updatedAt: new Date() })
      .where(eq(focusSessions.id, sessionId));

    return { satisfied: [current[index]!.label] };
  });
  // After commit: a slot declaring `relationToSubject` gets its output →
  // subject edge (subject-edge.ts — best-effort, never fails the satisfy).
  if (result.satisfied.length > 0) {
    await linkSatisfiedOutputsToSubject({ sessionId });
  }
  return result;
}

/**
 * Which output this approval satisfies, or `-1`. Pure, so the matching rule is
 * testable without a database (the transaction around it is not the logic).
 *
 * TWO rungs, in this order:
 *
 *   1. SLOT CLAIM — the not-yet-done output whose KEY equals `expectedKey`
 *      (`slot-keys.ts`), else whose `label` equals `expectedLabel` exactly
 *      (trimmed, case-insensitive), AND whose declared kind normalizes to
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
  expectedLabel?: string | null,
  entityProfileSlug?: string | null,
  expectedKey?: string | null
): number {
  const kind = resolveChangeKind(targetType, entityProfileSlug);
  // A slot declared as the bare `entity` is satisfied by ANY entity, profile or
  // not — that is what it asks for, and it is the behaviour every existing
  // session relies on. The profile only ever ADDS reach; it never narrows an
  // `entity` slot out of range.
  const isEntityChange = normalizeObjectKind(targetType) === "entity";
  const matchesKind = (o: ExpectedOutput): boolean => {
    const slot = normalizeObjectKind(o.kind);
    return slot === kind || (isEntityChange && slot === "entity");
  };

  // The claim names the slot by KEY first, then by label (`findSlotIndex`).
  if (expectedKey?.trim() || normalizeExpectedLabel(expectedLabel)) {
    const claimed = findSlotIndex(
      outputs,
      { key: expectedKey, label: expectedLabel },
      (o) => o.status !== "done" && matchesKind(o)
    );
    if (claimed !== -1) return claimed;
  }

  return outputs.findIndex(
    (o) => o.status !== "done" && o.owner !== "human" && matchesKind(o)
  );
}

/**
 * The object kind a CHANGE presents to the slot matcher.
 *
 * `targetType` is the row-level noun — `document`, `focus_session`, and for
 * every entity in the pod the single word `entity`. A declared slot, though, is
 * written in the vocabulary the agent and the profile registry share:
 * `kind: "knowledge"`, `kind: "task"`. So an entity change presents its PROFILE
 * when it has one, and the generic `entity` when it does not.
 *
 * This is the whole of the fix for the live defect where a `kind: "knowledge"`
 * slot could never be satisfied: three applied knowledge captures left it
 * pending, because `normalizeObjectKind("knowledge")` and
 * `normalizeObjectKind("entity")` are — correctly — different kinds.
 *
 * BOTH sides go through `normalizeObjectKind` (@synap-core/types/vocabulary),
 * the same door the render and governance layers use. There is deliberately no
 * alias table here: a profile slug IS an object kind in that vocabulary, so
 * teaching it a new profile is a row in `OBJECT_KIND_ALIASES`, never a second
 * map in this file.
 *
 * Pure, and exported so the rule is testable without a database.
 */
export function resolveChangeKind(
  targetType: string | null | undefined,
  entityProfileSlug?: string | null
): string {
  const kind = normalizeObjectKind(targetType);
  // The slug is read ONLY for an entity target: a document that happens to
  // carry a `profileSlug` in its payload is still a document.
  if (kind !== "entity") return kind;
  // `normalizeObjectKind(undefined)` is already `"entity"`, so an entity change
  // with no profile keeps exactly today's kind.
  return normalizeObjectKind(entityProfileSlug);
}

/**
 * Trim + casefold — the ONE comparison used on both sides of a label match.
 *
 * The implementation moved to the LEAF module `expected-label.ts` (see its
 * docblock) so the DB-free signal union can reuse the SAME rule; this file
 * stays the door every existing importer already names.
 */
export { normalizeExpectedLabel } from "./expected-label.js";

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
 * The PROFILE of the entity a stored proposal would produce — the ONE reader,
 * so the approval stamp cannot drift from where the executors look.
 *
 * NESTED FIRST, FLAT FALLBACK — the same posture as the `entity/create`
 * executor (`routers/proposals/executors/entity.ts`): the canonical envelope is
 * request-shaped (`proposals.data.data.profileSlug`); proposals pending before
 * that shape landed carry it flat. Reading only the flat key returns `undefined`
 * for every current proposal and leaves a `kind: "knowledge"` slot pending.
 *
 * Returns `undefined` when neither level names a profile (composite graphs have
 * no top-level slug; entity/update payloads carry none — the executor resolves
 * `targetEntity.profileId`). This reads the STORED envelope only: the gate
 * payload in `permission-check.ts` is already the inner object and is read
 * directly there.
 */
export function readProposalEntityProfileSlug(
  data: unknown
): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const outer = data as { profileSlug?: unknown; data?: unknown };
  const inner =
    outer.data && typeof outer.data === "object"
      ? (outer.data as { profileSlug?: unknown }).profileSlug
      : undefined;
  for (const value of [inner, outer.profileSlug]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
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

/**
 * ATTEST — the human owner of a blocked slot saying "I did this".
 *
 * The discharge verb for the other half of the board. Its counterpart is
 * "Not mine", which is `unblockExpectedOutput` (block-output.ts) and already
 * exists — there is deliberately no third verb, and above all no DISMISS: a row
 * may be closed or handed back, never merely hidden.
 *
 * OWNER-FLOORED like every other slot door: `focus_sessions` is owner-private
 * and carries no `VisibilityRule`, so the floor is an explicit `userId`
 * predicate and missing is indistinguishable from not-yours.
 *
 * THE 24h GUARD DOES NOT APPLY, and that is not an oversight. The window above
 * exists because an APPROVAL landing days after a session closed is not evidence
 * about that session's deliverables — the approver was reviewing an artefact,
 * not remembering the session. A human ticking a slot they personally owe IS
 * evidence about that slot whenever it arrives: "I minted the key" is true the
 * week after just as much as the hour after, and owed slots by their nature
 * accumulate on sessions that closed long ago. Gating attestation on the
 * proposal path's clock would make the oldest owed work — exactly the work most
 * in need of discharging — permanently undischargeable. The proposal path's
 * guard is untouched.
 */
export interface AttestExpectedOutputParams {
  sessionId: string;
  /** Owner floor AND the attesting identity — they are the same person. */
  userId: string;
  expectedLabel: string;
  /**
   * `true` ONLY from the grade door (`recordSessionEvaluation`, a human
   * verdict): the person's pass/fail IS the answer a criterion slot's
   * `choose` ask asked for, so discharging it is not "closing a question
   * unanswered". Honoured on a CRITERION slot only — any other slot with an
   * answer-shaped ask is still refused. Never set from a wire input.
   */
  criterionGraded?: boolean;
  /**
   * `askFingerprint(ask)` of the ask the person SAW (the lock-screen "I did
   * it"). Compared INSIDE the locked read, so an agent re-asking between the
   * check and the stamp cannot slip a different question under the attest.
   * Omit ⇒ unbound.
   */
  askFingerprint?: string;
}

export type AttestExpectedOutputResult =
  | { status: "not_found" }
  | { status: "unknown_label" }
  | { status: "already_done" }
  /** The slot is not the human's to close — an agent still owes it. */
  | { status: "not_owed_by_you" }
  /**
   * The slot was RETIRED — its session was cancelled, so the obligation ended.
   * Nothing to discharge, and attesting one would mint a receipt saying a human
   * delivered work that was called off.
   */
  | { status: "retired" }
  /**
   * The slot's ask resolves through the ANSWER door (confirm / choose / form /
   * provide): the agent needs the person's input, not a "done". Attesting it
   * would close the slot with the question unanswered.
   */
  | { status: "answer_required" }
  /** `askFingerprint` given and the slot's ask is no longer that one. */
  | { status: "ask_changed" }
  | {
      status: "attested";
      expectedLabel: string;
      kind: string;
      /** The slot as it stood BEFORE the stamp (delegatedTo, ask, …). */
      before: ExpectedOutput;
      attestedAt: string;
      session: {
        id: string;
        workspaceId: string | null;
        channelId: string | null;
        agentIds: string[];
      };
    };

export async function attestExpectedOutput(
  params: AttestExpectedOutputParams
): Promise<AttestExpectedOutputResult> {
  const { sessionId, userId, expectedLabel } = params;
  const wanted = normalizeExpectedLabel(expectedLabel);
  if (!wanted) return { status: "unknown_label" };

  const result = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        id: focusSessions.id,
        expectedOutputs: focusSessions.expectedOutputs,
        workspaceId: focusSessions.workspaceId,
        channelId: focusSessions.channelId,
        agentIds: focusSessions.agentIds,
      })
      .from(focusSessions)
      .where(
        and(eq(focusSessions.id, sessionId), eq(focusSessions.userId, userId))
      )
      .for("update");
    if (!locked) return { status: "not_found" as const };

    const current: ExpectedOutput[] = Array.isArray(locked.expectedOutputs)
      ? (locked.expectedOutputs as ExpectedOutput[])
      : [];
    const chosen = selectSlotToAttest(current, expectedLabel, {
      criterionGraded: params.criterionGraded === true,
    });
    if ("refused" in chosen) return { status: chosen.refused };
    const { index } = chosen;
    const slot = current[index]!;
    if (
      params.askFingerprint !== undefined &&
      askFingerprint(slot.ask ?? null) !== params.askFingerprint
    ) {
      return { status: "ask_changed" as const };
    }

    const now = new Date();
    const next = stampAttested(current, index, userId, now);
    await tx
      .update(focusSessions)
      .set({ expectedOutputs: next, updatedAt: now })
      .where(eq(focusSessions.id, sessionId));

    // The history row commits iff the attestation does.
    await logEvent(
      userId,
      FOCUS_SESSION_SLOT_ATTESTED_EVENT_TYPE,
      slotAttestedEventData(locked.id, slot, userId, now.toISOString()),
      {
        subjectId: locked.id,
        subjectType: FOCUS_SESSION_SUBJECT_TYPE,
        source: "api",
      },
      tx
    );

    return {
      status: "attested" as const,
      expectedLabel: slot.label,
      kind: slot.kind,
      before: slot,
      attestedAt: now.toISOString(),
      session: {
        id: locked.id,
        workspaceId: locked.workspaceId ?? null,
        channelId: locked.channelId ?? null,
        agentIds: Array.isArray(locked.agentIds) ? locked.agentIds : [],
      },
    };
  });

  if (result.status === "attested") {
    // The reactor hop — after commit, so a rule never fires on a rolled-back
    // attestation. Best-effort: the stamp and its history row already landed.
    try {
      await emitSideEffects({
        subjectType: FOCUS_SESSION_SUBJECT_TYPE,
        action: FOCUS_SESSION_SLOT_ATTEST_ACTION,
        subjectId: result.session.id,
        userId,
        workspaceId: result.session.workspaceId ?? undefined,
        sessionId: result.session.id,
        data: slotAttestedEventData(
          result.session.id,
          result.before,
          userId,
          result.attestedAt
        ),
      });
    } catch (err) {
      attestLogger.warn(
        { err, sessionId: result.session.id },
        "slot_attested side-effect emit failed — the attestation is recorded"
      );
    }
    // "I did this" on an undecided agent draft takes the draft on — the ONE
    // acceptance door, after commit, idempotent (accept-on-engagement.ts).
    await acceptDraftOnEngagement({ sessionId: result.session.id, userId });
    // The attested slot's declared output → subject edge, when its `ref`
    // names the entity (subject-edge.ts; best-effort).
    await linkSatisfiedOutputsToSubject({ sessionId: result.session.id });
  }
  return result;
}

function slotAttestedEventData(
  sessionId: string,
  slot: ExpectedOutput,
  attestedBy: string,
  attestedAt: string
): Record<string, unknown> {
  return {
    sessionId,
    expectedLabel: slot.label,
    kind: slot.kind,
    blockedReason: slot.blockedReason ?? null,
    askMode: slot.ask?.mode ?? null,
    attestedBy,
    attestedAt,
  };
}

/**
 * WHICH slot an attestation may close, or WHY it may not. Pure, so all three
 * floors are testable without a database — the same split
 * `selectOutputToSatisfy` has from its own transaction.
 *
 * The floors, in the order a caller meets them:
 *   - the label must name a DECLARED slot (`unknown_label`);
 *   - the slot must not already be delivered (`already_done`) — re-stamping
 *     would overwrite approval lineage with an attestation and destroy the
 *     distinction between the two kinds of evidence;
 *   - the slot must be the HUMAN's (`not_owed_by_you`). This is the floor that
 *     matters: without it, "I did this" becomes a way for anyone holding a
 *     session to close work an agent still owes, with a receipt saying a human
 *     did it. Absent `owner` means AGENT (see `ExpectedOutput`), so the test is
 *     a positive `=== "human"` and an un-owned slot is correctly refused.
 *   - the slot must not be RETIRED (`retired`) — a cancelled session's slots are
 *     stamped, not deleted, so they stay readable and stay reachable BY LABEL
 *     long after the obligation ended.
 */
export function selectSlotToAttest(
  outputs: ExpectedOutput[],
  expectedLabel: string | null | undefined,
  opts: { criterionGraded?: boolean } = {}
):
  | { index: number }
  | {
      refused:
        | "unknown_label"
        | "already_done"
        | "not_owed_by_you"
        | "retired"
        | "answer_required";
    } {
  // KEY first, then the label (`findSlotIndex`) — `expectedLabel` may carry
  // either.
  if (!expectedLabel?.trim()) return { refused: "unknown_label" };
  const index = findSlotIndex(outputs, expectedLabel, (o) => !!o);
  if (index === -1) return { refused: "unknown_label" };
  const slot = outputs[index]!;
  if (slot.status === "done") return { refused: "already_done" };
  if (slot.owner !== "human") return { refused: "not_owed_by_you" };
  // A RETIRED slot is not owed and so is not dischargeable. The owed read
  // (`isOwedSlot`) already drops it on `retiredAt`, so it cannot reach a "needs
  // you" surface — but the attest door is reachable by label, and without this
  // it would stamp `attestedBy`/`attestedAt` onto a slot whose session was
  // CANCELLED. That is a receipt asserting a person delivered work that was
  // called off, and it is unfalsifiable afterwards: `retiredAt` and `attestedAt`
  // would both stand, with nothing to say which one is the truth.
  if (slot.retiredAt != null) return { refused: "retired" };
  // A slot whose ask wants INPUT (confirm / choose / form / provide) is
  // answered, never attested: "I did this" on "Which region?" would close the
  // slot with the agent's question unanswered. `act` and an absent ask (the
  // legacy verbs) attest as before.
  // The ONE exception: a criterion slot discharged BY its grade — the
  // verdict is the answer its pass/fail ask wanted (see `criterionGraded`).
  const gradedCriterion =
    opts.criterionGraded === true && slot.kind === CRITERION_SLOT_KIND;
  if (resolveAskResolution(slot.ask) === "answer" && !gradedCriterion) {
    return { refused: "answer_required" };
  }
  return { index };
}

/**
 * The attestation stamp — status + WHO said so and WHEN, every other slot
 * untouched. Pure.
 *
 * `owner` and `owedSince` are deliberately KEPT: they are the record of who owed
 * this and since when, which is the whole receipt. The slot leaves the owed read
 * on `status`, not by having its history erased.
 */
export function stampAttested(
  outputs: ExpectedOutput[],
  index: number,
  userId: string,
  now: Date = new Date()
): ExpectedOutput[] {
  return outputs.map((o, i) =>
    i === index
      ? {
          ...o,
          status: "done" as const,
          attestedBy: userId,
          attestedAt: now.toISOString(),
        }
      : o
  );
}

// ── THE THIRD PATH: EVIDENCE (A3, "done has one door") ─────────────────────

/** What an evidence verdict cites. See `ExpectedOutput.satisfiedByEvidence`. */
export interface SlotEvidence {
  kind: "output" | "ref";
  id: string;
}

/** The slot's own declared pointer, as evidence (`{kind,id}` or `{url}`). */
export function refEvidence(slot: ExpectedOutput): SlotEvidence | null {
  const ref = slot.ref;
  if (!ref) return null;
  if ("url" in ref) return { kind: "ref", id: ref.url };
  return { kind: "ref", id: `${ref.kind}:${ref.id}` };
}

/**
 * WHICH claims the evidence closes. Pure — every floor is testable without a
 * database, the `selectSlotToAttest` precedent.
 *
 * A slot is closed by evidence only when ALL hold:
 *   - the agent CLAIMED it (`claimedDone`) — evidence without a claim is a
 *     produced object, not a delivery; the agent still says when it is done;
 *   - it is not already done (any door) and not retired;
 *   - it is NOT the person's (`owner: 'human'`): a person's deliverable is
 *     checked by the person (attest / answer), never by what an agent made;
 *   - no CRITERION shares its key: such an outcome is checked by that
 *     criterion's evaluator (`judge` / `capability` / `human` — evaluate_session),
 *     and evidence alone would short-circuit the check it declared;
 *   - there IS evidence: a produced object the output join attributed to the
 *     slot (`evidenceByKey`, keyed by slot key), else the slot's own `ref`.
 */
export function selectClaimsWithEvidence(
  outputs: readonly ExpectedOutput[],
  evidenceByKey: ReadonlyMap<string, SlotEvidence>,
  criterionKeys: ReadonlySet<string>
): Array<{ index: number; evidence: SlotEvidence }> {
  const keys = deriveSlotKeys(outputs);
  const out: Array<{ index: number; evidence: SlotEvidence }> = [];
  outputs.forEach((slot, index) => {
    const key = keys[index];
    if (!slot || !key) return;
    if (slot.claimedDone !== true) return;
    if (slot.status === "done" || slot.retiredAt != null) return;
    if (slot.owner === "human") return;
    if (criterionKeys.has(key)) return;
    const evidence = evidenceByKey.get(key) ?? refEvidence(slot);
    if (evidence) out.push({ index, evidence });
  });
  return out;
}

/**
 * The evidence stamp — status + the evidence it cites. Pure. Like
 * {@link stampSatisfied}, the `done` here always carries its lineage.
 */
export function stampEvidenced(
  outputs: ExpectedOutput[],
  picks: ReadonlyArray<{ index: number; evidence: SlotEvidence }>,
  now: Date = new Date()
): ExpectedOutput[] {
  const byIndex = new Map(picks.map((p) => [p.index, p.evidence]));
  return outputs.map((o, i) => {
    const evidence = byIndex.get(i);
    return evidence
      ? {
          ...o,
          status: "done" as const,
          satisfiedByEvidence: { ...evidence, at: now.toISOString() },
        }
      : o;
  });
}

export interface SatisfyClaimsByEvidenceResult {
  /** The slots this call closed (key + stored label). */
  satisfied: Array<{ key: string; label: string; evidence: SlotEvidence }>;
  /** The array as written, when anything was closed. */
  outputs?: ExpectedOutput[];
}

/**
 * THE EVIDENCE VERDICT — the agent brings evidence, the pod decides.
 *
 * Called after every write that can complete the picture: a claim
 * (`completeOutput`, update-session.ts), a slot patch that may add a `ref`,
 * and an artifact recorded against a slot (`record-session-artifact.ts`).
 * Idempotent: a slot already done is never re-stamped.
 *
 * The evidence is read through THE output join (`listOutputsForSessions`) —
 * the same attribution every surface shows under "what this produced" — so a
 * slot is never closed by an object the room would not show against it.
 * Owner-floored like every slot door. Best-effort for its callers: a failure
 * leaves the claim standing, which is the honest state.
 */
export async function satisfyClaimsByEvidence(params: {
  sessionId: string;
  userId: string;
  now?: Date;
}): Promise<SatisfyClaimsByEvidenceResult> {
  const { sessionId, userId } = params;
  const session = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, sessionId),
      eq(focusSessions.userId, userId)
    ),
    columns: { id: true, expectedOutputs: true, criteria: true },
  });
  if (!session) return { satisfied: [] };
  const slots: ExpectedOutput[] = Array.isArray(session.expectedOutputs)
    ? (session.expectedOutputs as ExpectedOutput[])
    : [];
  // Nothing claimed and still open ⇒ nothing to decide (and no join to run).
  if (!slots.some((s) => s?.claimedDone === true && s.status !== "done")) {
    return { satisfied: [] };
  }

  // The join runs only when a claimed slot has no `ref` to stand on — a
  // claim with its own pointer needs no ledger read. A FAILED join throws to
  // the caller (the claim then stands): it is never read as "no evidence".
  const keys = deriveSlotKeys(slots);
  const evidenceByKey = new Map<string, SlotEvidence>();
  const needsJoin = slots.some(
    (s) => s?.claimedDone === true && s.status !== "done" && !s.ref
  );
  const joined = needsJoin
    ? (
        await (
          await import("./session-outputs.js")
        ).listOutputsForSessions(db, [
          { id: session.id, expectedOutputs: slots },
        ])
      ).get(session.id)
    : undefined;
  for (const output of joined?.outputs ?? []) {
    if (!output.expected) continue;
    const index = findSlotIndex(slots, {
      key: output.expected.key ?? null,
      label: output.expected.label,
    });
    const key = index === -1 ? null : keys[index];
    if (key && !evidenceByKey.has(key)) {
      evidenceByKey.set(key, { kind: "output", id: output.id });
    }
  }
  const criterionKeys = new Set(
    readCriteria(session.criteria).map((c) => c.key)
  );

  const now = params.now ?? new Date();
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ expectedOutputs: focusSessions.expectedOutputs })
      .from(focusSessions)
      .where(
        and(eq(focusSessions.id, sessionId), eq(focusSessions.userId, userId))
      )
      .for("update");
    const current: ExpectedOutput[] = Array.isArray(locked?.expectedOutputs)
      ? (locked.expectedOutputs as ExpectedOutput[])
      : [];
    // Re-selected on the LOCKED array: a slot reworded, retired or closed
    // since the read above is judged as it now stands. Evidence is by KEY,
    // so a reorder cannot move it onto another slot.
    const picks = selectClaimsWithEvidence(
      current,
      evidenceByKey,
      criterionKeys
    );
    if (picks.length === 0) return { satisfied: [] };
    const next = stampEvidenced(current, picks, now);
    await tx
      .update(focusSessions)
      .set({ expectedOutputs: next, updatedAt: now })
      .where(eq(focusSessions.id, sessionId));
    const currentKeys = deriveSlotKeys(current);
    return {
      satisfied: picks.map((p) => ({
        key: currentKeys[p.index]!,
        label: current[p.index]!.label,
        evidence: p.evidence,
      })),
      outputs: next,
    };
  }).then(async (r) => {
    // After commit — the evidenced slots' declared output → subject edges.
    if (r.satisfied.length > 0) {
      await linkSatisfiedOutputsToSubject({ sessionId, now });
    }
    return r;
  });
}
