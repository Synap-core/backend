/**
 * WHO moves a process step on, for its mark (Process wave plan 0adf8352 W4).
 * ONE classifier the desktop and pod admin both read ("no surface forks a
 * rule"). The rule: a `human` gate (the string or the stored `{ kind }`) →
 * `person`; every other step → `ai`, whatever its runner or other gate (every
 * runner shape names an agent, and a `check` gate only holds the move into the
 * step: `trackStepGateLabel` names it). `automatic` is declared and
 * unreachable until W2b declares "an automation moves this step". Pure.
 */

export const PROCESS_STEP_RUNNER_KINDS = ["ai", "person", "automatic"] as const;
export type ProcessStepRunnerKind = (typeof PROCESS_STEP_RUNNER_KINDS)[number];

/** A step as any surface holds it: the read contract's or the stored stage. */
export interface ClassifiableStep {
  /** `human` | `check` | `awaits` | null, or the stored `{ kind }` object. */
  gate?: unknown;
  /** `PlaybookRunner`: one choice or an ordered list; null = the run's own agent. */
  runner?: unknown;
}

function gateKind(gate: unknown): string | null {
  if (typeof gate === "string") return gate;
  if (gate && typeof gate === "object" && "kind" in gate) {
    const kind = (gate as { kind?: unknown }).kind;
    return typeof kind === "string" ? kind : null;
  }
  return null;
}

export function classifyStepRunner(
  step: ClassifiableStep
): ProcessStepRunnerKind {
  const gate = gateKind(step.gate);
  if (gate === "human") return "person";
  // Any other gate is a mark, not a runner; every runner choice is an agent.
  return "ai";
}
