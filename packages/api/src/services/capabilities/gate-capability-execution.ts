/**
 * Capability-execution gate — RE-EXPORT SHIM.
 *
 * The gate itself moved to `@synap/capability-gate` (a thin package depending
 * only on `@synap/database` + `@synap/governance-policy`) so that BOTH
 * `@synap/api` AND `@synap/jobs` can import the SAME full gate. `@synap/jobs`
 * cannot import `@synap/api` (api → jobs already = a cycle), which previously
 * forced the jobs automation door to fall back to an approved-only check. This
 * module preserves the original import path for the existing api call sites
 * (external-dispatch.ts, skills.ts, approve-executors.ts) with ZERO behavior
 * change — the decision logic is byte-identical, only its location moved.
 *
 * Part of the Playbooks & Capability Substrate (G4 — per-capability governance).
 */

export {
  gateCapabilityExecution,
  CAPABILITY_RUN_PROPOSAL,
} from "@synap/capability-gate";
export type {
  CapabilityRunKind,
  GateToolRow,
  GateSkillRow,
  GateCapabilityExecutionInput,
  GateCapabilityDecision,
} from "@synap/capability-gate";
