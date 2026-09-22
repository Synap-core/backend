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
 * The first six are DISPATCH outcomes (`classifyDispatchFailure`); the last
 * four classify a proposal APPLY and dispatch never returns them. They share
 * one union deliberately — a second parallel enum would be a fork of the one
 * table both sides read.
 *
 *   auth           — the connection's credentials were refused    → RECONNECT
 *   no_connection  — nothing is connected for this yet            → CONNECT
 *   transient      — a temporary problem                          → RETRY
 *   permission     — needs a permission the actor does not hold
 *   target_missing — what it points at no longer exists
 *   provider       — the other service refused it
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
