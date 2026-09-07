/**
 * The capture receipt's honesty words — PURE, and deliberately in their own
 * module rather than inside `submit-capture-graph.ts`.
 *
 * Every caller of `submitCaptureGraph` reaches it through a dynamic import, and
 * the ones under test replace that whole module with a `vi.mock`. A pure helper
 * living in there would be mocked away with it — the derivation would vanish at
 * exactly the moment a test believed it was exercising the door. Kept here, it
 * is imported statically and can never be stubbed out.
 *
 * `partial` is NOT a new word: it is the Hub Protocol receipt state defined on
 * `CreateWriteReceipt` (routers/hub-protocol/write-receipt.ts) and already
 * carried by `HubWriteReceipt` in @synap-core/hub-rest-client — "storage changed for
 * SOME sub-writes and failed for others; never a claim of rollback".
 */

/** The three states a capture graph's write receipt can carry. */
export type CaptureReceiptState = "pending" | "applied" | "partial";

/** The receipt state of a graph that DID materialize (never `pending`). */
export type MaterializedReceiptState = "applied" | "partial";

/**
 * THE ONE derivation of a materialized capture graph's receipt state.
 *
 * A capture graph's relations are a non-atomic follow-up to its entities: pass 1
 * creates the entities, pass 2 creates each edge independently, and an edge
 * whose TYPE does not resolve fails alone. Reproduced live 2026-09-07 — 9
 * entities + 11 relations under a project focus (entities placed pod-wide,
 * where no workspace-scoped relation def resolves) came back `applied` with
 * `relationCount: 0` and all eleven failures buried in `relationsFailed[]`.
 *
 * Same class as `status ?? "installed"` and `changeType ?? "update"`: the good
 * news is the default and the bad news is opt-in.
 */
export function materializedReceiptState(
  relationsFailedCount: number
): MaterializedReceiptState {
  return relationsFailedCount > 0 ? "partial" : "applied";
}

/**
 * `writeReceipt.state` → the word a caller-facing door reports as `status`.
 *
 * `pending` becomes `proposed` (a queued write with a review link, which the
 * tool description teaches is SUCCESS); `applied`/`partial` pass through.
 *
 * Doors must derive `status` through THIS function, never from the result's
 * `applied` boolean. `applied` is the ROUTING flag — "did this terminal
 * materialize?" — and stays true for a graph whose every edge failed. Using it
 * as the outcome word is the defect.
 */
export function captureStatusForReceiptState(
  state: CaptureReceiptState
): "proposed" | MaterializedReceiptState {
  return state === "pending" ? "proposed" : state;
}
