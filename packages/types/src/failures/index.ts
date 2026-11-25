/**
 * `@synap-core/types/failures` — the ONE list of failure classes a failed
 * dispatch or a failed proposal-apply can carry.
 *
 * `data.failure.errorClass` is ONE field persisted by the pod and read by every
 * client, so it gets ONE table. It used to be written out four times: the union
 * in `connectors/external-dispatch.ts`, a hand-written `DUCK_CLASSES` Set in
 * `routers/proposals/failure-classification.ts`, the union + list in
 * `@synap-core/proposal-types/failureAction`, and the generated api-types. Each
 * copy could fall behind independently, and one did: relay's set held six
 * members while the pod wrote ten, so a `missing_field` row — the sharpest
 * class there is, the only one carrying a repair affordance — validated as
 * UNKNOWN on the phone and degraded to a regex over prose.
 *
 * Zero imports, so the pod, the api, the clients and relay can all reach it.
 *
 * Adding a class: add it HERE. The union derives; `DUCK_CLASSES` derives; the
 * client's `isFailureErrorClass` derives; and the coverage floor in
 * `resolveFailureAction.ts` fails the BUILD until the new class is classified
 * as actioned or deliberately un-actioned.
 */

/**
 * Every failure class, in the order the two classifiers reach for them.
 *
 * The first six are DISPATCH outcomes (`classifyDispatchFailure`); the rest
 * classify a proposal APPLY, or are the send door's own refusal before it sends
 * (`not_connected`); dispatch never returns them. They share
 * one union deliberately — a second parallel enum would be a fork of the one
 * table both sides read.
 *
 *   auth           — the connection's credentials were refused    → RECONNECT
 *   no_connection  — nothing is connected for this yet            → CONNECT
 *   transient      — a temporary problem                          → RETRY
 *   permission     — needs a permission the actor does not hold
 *   target_missing — what it points at no longer exists
 *   kind_missing   — the kind it names is not available in the space it
 *                    was filed in (it may exist in another space)
 *   provider       — the other service refused it
 *   not_connected  — the person is not connected to the recipient on that
 *                    network (LinkedIn messages only 1st-degree connections)
 *                                                               → CONNECT FIRST
 *   do_not_contact — the recipient person is marked do not contact: the send
 *                    door refuses every message to them (founder, 2026-11-09)
 *                                                               → no action
 *   missing_field  — the request declared a parameter it never supplied → FILL
 *   validation     — the supplied values are not valid for the target
 *   conflict       — the target changed under the proposal (stale/duplicate)
 *   unknown        — classified by nobody. The honest answer, never a guess.
 */
export const FAILURE_ERROR_CLASSES = [
  "auth",
  "no_connection",
  "transient",
  "permission",
  "target_missing",
  "provider",
  "missing_field",
  "validation",
  "conflict",
  // Added 2026-11-02. A client built before it reads the value as unknown
  // (`isFailureErrorClass` → false) and falls back to its generic wording,
  // which stays true.
  "kind_missing",
  // Added 2026-11-03 (the channels send door), same rule as kind_missing.
  "not_connected",
  // Added 2026-11-09 (do-not-contact at the send door), same rule as
  // kind_missing: an older client reads it as unknown and says so.
  "do_not_contact",
  "unknown",
] as const;

export type FailureErrorClass = (typeof FAILURE_ERROR_CLASSES)[number];

/** Is this raw JSONB string a `FailureErrorClass` this build knows? */
export function isFailureErrorClass(
  value: unknown
): value is FailureErrorClass {
  return (
    typeof value === "string" &&
    (FAILURE_ERROR_CLASSES as ReadonlyArray<string>).includes(value)
  );
}
