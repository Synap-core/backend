/**
 * WHO moves a process step on, for its mark (Process wave plan 0adf8352 W4:
 * the step strip colours each step by who runs it — AI, you, automatic). ONE
 * classifier the desktop and pod admin both read ("no surface forks a rule").
 *
 * Read from BOTH the step's entry gate and its runner (`PlaybookStage.gate`,
 * `PlaybookStage.runner`, spec 7111934d §2.1), in this order:
 *   1. a `human` gate → `person`: the step waits for a person to let it in;
 *   2. otherwise the runner decides → `ai`: every runner shape names an
 *      AGENT — `"self"` (the run's own agent), `"synap_ai"` / `{ synapAi }`
 *      (the pod's AI), `{ agentId }`,
 *      `{ role }` (any of the person's agents holding that role) and
 *      `{ engine }` (any of the person's agents of that engine, e.g.
 *      `claude-code`: an agent runtime, not a machine step);
 *   3. no runner, no gate → `ai`: the run's own agent works it (`"self"` is
 *      the declared default).
 *
 * A `check` gate is NOT a runner kind: it judges the stage being LEFT (someone
 * works the step, then its criteria are checked; `stage-gate.ts`), so a
 * check-gated step is drawn by its runner, and surfaces render the check as its
 * own mark from `step.gate`. `automatic` stays in PROCESS_STEP_RUNNER_KINDS but
 * is UNREACHABLE today: nothing declares "an automation moves this step" yet
 * (Process wave W2b); when that declaration exists, it is read here.
 *
 * TOTAL over every stored shape: a gate given as a string (`"human"`, the read
 * contract) or as the stored object (`{ kind: "human" }`), a runner given as
 * one choice or as an ordered fallback list (the FIRST choice decides), and an
 * unknown runner shape (read as an agent, never thrown on). `check`, `awaits`
 * and any other gate value fall through to the runner. Pure, dependency-free.
 */

/**
 * The kinds of a step's gate (`@synap/playbooks` `StageGate.kind`): `human`
 * (the entry gate: a person approves before the step starts), `check` (judges
 * the step being LEFT: its criteria are checked before it moves on), `awaits`
 * (waits for a proposal's approval, e.g. a deploy, before it moves on). Their
 * words: `resolveGateKindLabel` (`@synap-core/types/vocabulary`).
 */
export const PROCESS_GATE_KINDS = ["human", "check", "awaits"] as const;
export type ProcessGateKind = (typeof PROCESS_GATE_KINDS)[number];

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
  // A `check` gate is a mark, not a runner (see the header). Every runner choice is an agent (see the header); the first choice of a
  // fallback list is the one that runs when it can, and none is a machine step.
  return "ai";
}
