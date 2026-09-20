/**
 * A `check`-gated stage refused to let a run advance: where that refusal is
 * recorded, and the stand-in for "the check never ran".
 *
 * ONE definition, HERE rather than beside the service that writes it, for the
 * same reason as `criterion-slot.ts`: the readers are UIs. A paused session
 * whose cause is unrendered looks exactly like a session a person paused, and
 * `@synap-core/types` is the only backend package the browser and relay can
 * resolve (neither links the `@synap/*` scope).
 */

/** Where the refusal is recorded on `focus_sessions.metadata`. */
export const CHECK_GATE_METADATA_KEY = "checkGate";

/**
 * Stands in `failing` when the evaluation itself could not run. NOT a criterion
 * key: it names the ABSENCE of a verdict, so a surface can say "the check did
 * not run" rather than blaming a criterion — and must never read as passed.
 */
export const CHECK_GATE_UNEVALUATED = "__unevaluated";
