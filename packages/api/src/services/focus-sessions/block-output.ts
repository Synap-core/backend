/**
 * blockExpectedOutput / unblockExpectedOutput — hand ONE declared deliverable of
 * a focus session TO the human, and take it back.
 *
 * WHY A TARGETED DOOR AND NOT A PATCH. `mergeExpectedOutputs` has exactly two
 * categories, and neither fits a field the agent AUTHORS but the server must
 * CARRY. Inside `SERVER_OWNED_OUTPUT_FIELDS`, silence means "keep" — so a slot
 * can be blocked and then never unblocked, because saying nothing is how you
 * keep it. Outside the list, any client echoing the array back ERASES it — the
 * bug that list exists for. The codebase's existing answer to exactly this shape
 * is a targeted stamper: `delegateExpectedOutput` sets `delegatedTo`, and
 * `returnDelegatedSlot` clears it. These two are the same pair for ownership.
 *
 * WHAT THEY WRITE. `owner` + `blockedReason` + `why` + `owedSince`, all four
 * together, and all four cleared together — the way `stampReturned` clears
 * `delegatedTo`/`delegatedAt` as a unit. A `blockedReason` with no `owner` is a
 * classification of nothing, and an `owedSince` on an agent-owned slot is a
 * clock on work nobody is waiting for. `owedSince` itself is never taken from
 * the caller: `reconcileOwedSince` (update-session.ts) owns the invariant, so
 * the timestamp is an observation the server makes rather than a claim an agent
 * files.
 *
 * WHAT THEY DELIBERATELY DO NOT WRITE. `status`. A blocked slot is `pending` and
 * stays `pending` — declaring that you cannot do something is the opposite of
 * delivering it, and `satisfyExpectedOutputs` remains the ONE door that stamps
 * `done`. Unblocking is not a delivery either: the agent reclaiming a slot it
 * can now do owes the same deliverable it always did.
 *
 * UNBLOCK CLEARS THE HUMAN'S OWNERSHIP BY DELETING IT, never by writing
 * `owner: 'agent'`. An absent `owner` and a stored `'agent'` must stay
 * indistinguishable (see `ExpectedOutput`), or "the agent never said" becomes
 * unreadable the moment one door starts saying it explicitly.
 *
 * OWNER-FLOORED exactly like its siblings: `focus_sessions` is owner-private and
 * carries no `VisibilityRule`, so the floor is an explicit `userId` predicate on
 * the load. Missing and not-yours are indistinguishable.
 */

import { db, focusSessions, and, eq } from "@synap/database";
import type {
  BlockedReason,
  ExpectedOutput,
  OutputRef,
} from "@synap/playbooks";
import {
  findUnreachableOutputRefs,
  unreachableOutputRefError,
} from "./assert-output-ref-visible.js";
import { normalizeExpectedLabel } from "./satisfy-expected-output.js";
import { updateExpectedOutputsLocked } from "./delegate-output.js";
import { reconcileOwedSince } from "./update-session.js";

export interface BlockExpectedOutputParams {
  sessionId: string;
  /** Owner floor — the session must belong to this user. */
  userId: string;
  /** The declared slot label to hand over (matched trimmed + case-insensitive). */
  expectedLabel: string;
  /** The class of thing that would unblock it. */
  blockedReason: BlockedReason;
  /** ONE line naming WHICH thing is missing, not its class. */
  why?: string;
  /**
   * WHERE the person must go — an in-pod object or an external link. Optional,
   * and it is what turns "the Stripe restricted key for the live account" from
   * a sentence into a door.
   *
   * `null` CLEARS a stored pointer, matching the wire's meaning everywhere else;
   * `undefined` leaves whatever the slot already carried, because handing a slot
   * over says nothing about a pointer somebody already declared on it.
   *
   * NOT cleared by `unblockExpectedOutput`. `ref` describes the DELIVERABLE
   * ("this is the thing"), not the blocker — the four ownership fields are what
   * go together, and a pointer stays true after the agent reclaims the slot.
   */
  ref?: OutputRef | null;
}

export interface UnblockExpectedOutputParams {
  sessionId: string;
  userId: string;
  expectedLabel: string;
}

export type BlockExpectedOutputResult =
  | { status: "not_found" }
  /** No declared slot carries that label. */
  | { status: "unknown_label" }
  /** The slot is already satisfied — handing a delivered thing over is a no-op. */
  | { status: "already_done" }
  /**
   * The `ref` names an object the caller cannot see. A distinct member rather
   * than a silent drop: a caller told "blocked" while its pointer was discarded
   * would put an undoorable card on the board and believe otherwise.
   */
  | { status: "ref_unreachable"; reason: string }
  | {
      status: "blocked" | "unblocked";
      /** The DECLARED label (the slot's own casing), never the caller's. */
      expectedLabel: string;
      kind: string;
    };

/**
 * Load the slot behind the owner floor. Shared by both doors so the two cannot
 * drift into two answers about what "not yours" looks like.
 */
async function loadSlot(
  sessionId: string,
  userId: string,
  expectedLabel: string
): Promise<
  | { ok: false; result: BlockExpectedOutputResult }
  | { ok: true; slot: ExpectedOutput }
> {
  const session = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, sessionId),
      eq(focusSessions.userId, userId)
    ),
    columns: { id: true, expectedOutputs: true },
  });
  if (!session) return { ok: false, result: { status: "not_found" } };

  const outputs: ExpectedOutput[] = Array.isArray(session.expectedOutputs)
    ? (session.expectedOutputs as ExpectedOutput[])
    : [];
  const wanted = normalizeExpectedLabel(expectedLabel);
  const slot = wanted
    ? outputs.find((o) => normalizeExpectedLabel(o.label) === wanted)
    : undefined;
  if (!slot) return { ok: false, result: { status: "unknown_label" } };
  if (slot.status === "done") {
    return { ok: false, result: { status: "already_done" } };
  }
  return { ok: true, slot };
}

export async function blockExpectedOutput(
  params: BlockExpectedOutputParams
): Promise<BlockExpectedOutputResult> {
  const loaded = await loadSlot(
    params.sessionId,
    params.userId,
    params.expectedLabel
  );
  if (!loaded.ok) return loaded.result;
  const { slot } = loaded;

  // ONE door for the ref floor — the same `isOutputRefVisible` the attach-output
  // doors apply. Checked BEFORE the lock: a refusal must change nothing.
  if (params.ref) {
    const unreachable = await findUnreachableOutputRefs({
      userId: params.userId,
      outputs: [{ label: slot.label, ref: params.ref }],
    });
    if (unreachable.length > 0) {
      return {
        status: "ref_unreachable",
        reason: unreachableOutputRefError(unreachable),
      };
    }
  }

  // Re-derived INSIDE the lock from the REQUESTED label, never from the array
  // this call read before it — the TOCTOU the delegation door documents.
  const stamped = await updateExpectedOutputsLocked(
    params.sessionId,
    (current) =>
      stampBlocked(
        current,
        slot.label,
        params.blockedReason,
        params.why,
        undefined,
        params.ref
      )
  );
  if (!stamped) return { status: "not_found" };

  return { status: "blocked", expectedLabel: slot.label, kind: slot.kind };
}

export async function unblockExpectedOutput(
  params: UnblockExpectedOutputParams
): Promise<BlockExpectedOutputResult> {
  const loaded = await loadSlot(
    params.sessionId,
    params.userId,
    params.expectedLabel
  );
  if (!loaded.ok) return loaded.result;
  const { slot } = loaded;

  const stamped = await updateExpectedOutputsLocked(
    params.sessionId,
    (current) => stampUnblocked(current, slot.label)
  );
  if (!stamped) return { status: "not_found" };

  return { status: "unblocked", expectedLabel: slot.label, kind: slot.kind };
}

/**
 * Hand the named slot to the human, every other slot untouched. Pure, so the
 * rule is testable without a database.
 */
export function stampBlocked(
  outputs: ExpectedOutput[],
  label: string,
  blockedReason: BlockedReason,
  why?: string | null,
  now: Date = new Date(),
  /**
   * `undefined` leaves a stored pointer alone; `null` clears it — the same
   * three-state contract the wire uses, so the targeted door and the wholesale
   * patch cannot mean two different things by the same value.
   */
  ref?: OutputRef | null
): ExpectedOutput[] {
  const wanted = normalizeExpectedLabel(label);
  const trimmed = (why ?? "").trim();
  return outputs.map((o) => {
    if (normalizeExpectedLabel(o.label) !== wanted) return o;
    // Spread, never re-list: a field added to `ExpectedOutput` tomorrow rides
    // through here untouched instead of being silently dropped.
    const withRef: ExpectedOutput = { ...o };
    if (ref === null) delete withRef.ref;
    else if (ref !== undefined) withRef.ref = ref;
    return reconcileOwedSince(
      {
        ...withRef,
        owner: "human",
        blockedReason,
        ...(trimmed ? { why: trimmed } : {}),
      },
      now
    );
  });
}

/**
 * The agent reclaiming a slot it can now do: all four ownership fields go
 * together. Pure.
 */
export function stampUnblocked(
  outputs: ExpectedOutput[],
  label: string
): ExpectedOutput[] {
  const wanted = normalizeExpectedLabel(label);
  return outputs.map((o) => {
    if (normalizeExpectedLabel(o.label) !== wanted) return o;
    const {
      owner: _owner,
      blockedReason: _blockedReason,
      why: _why,
      owedSince: _owedSince,
      ...rest
    } = o;
    return rest;
  });
}
