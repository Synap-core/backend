/**
 * The `ExpectedOutput.kind` an ESCALATED criterion is filed under, when the
 * automatic attempts are exhausted and the human must grade it.
 *
 * ONE definition, and it lives HERE rather than beside the service that writes
 * it, because the readers are UIs: a needs-you tray must tell a criterion slot
 * from an ordinary deliverable, since it takes a DIFFERENT verb — grade it on
 * the session's scorecard, never "I did this" / attest. `@synap-core/types` is
 * the only backend package the browser and relay can resolve (neither links the
 * `@synap/*` scope), and `@synap/playbooks` is deliberately dependency-free, so
 * it cannot be the home either.
 */
export const CRITERION_SLOT_KIND = "criterion";
