/**
 * RUNNER STATES — what a runner (one OS process of a client conversation
 * holding a session, `session_runners`, 0384) says it is doing, and the ONE
 * order those words take.
 *
 * The set is what a harness adapter may send (`X-Synap-Runner-State`, or
 * `_meta["live.synap/runnerState"]`; parsed by `parseRunnerState` in
 * `@synap/database`). `ended` is for a harness that knows its conversation
 * stopped: an ended runner is not live and says nothing about now.
 *
 * Every live word maps to ONE wait kind ({@link RUNNER_STATE_WAIT_KIND}), and
 * its KEY ORDER is the urgency order: the session-level fold
 * (`foldRunnerState`), the holder's rank and word (`session-holder.ts`) and the
 * needs-you rule (`classifyRunnerWait`) all read it. A word added to
 * {@link RUNNER_STATES} without a row there stops the build: before this
 * order, a new word fell through to the holder's live rule in silence.
 *
 * Pure and import-free at run time (types only).
 */
import type { WaitKind } from "./wait-kind.js";

/** Every word a runner may say, in the order clients document them. */
export const RUNNER_STATES = [
  "busy",
  "idle",
  "needs_permission",
  "needs_answer",
  "ended",
] as const;
export type RunnerState = (typeof RUNNER_STATES)[number];

/** A word a LIVE runner says (an ended one says nothing about now). */
export type LiveRunnerState = Exclude<RunnerState, "ended">;

/**
 * THE order: each live word's wait kind, most urgent first.
 *   needs_permission → approval: a permission dialog waits at the terminal;
 *   needs_answer → answer: a question (or a plan to accept) waits at the
 *     terminal;
 *   busy → agent_work · idle → agent_stopped.
 * Both terminal waits are the person's move (`WAIT_KIND_BALL`), so a session
 * whose runner says either is in needs-you.
 */
export const RUNNER_STATE_WAIT_KIND = {
  needs_permission: "approval",
  needs_answer: "answer",
  busy: "agent_work",
  idle: "agent_stopped",
} as const satisfies Record<LiveRunnerState, WaitKind>;

/** The live words, most urgent first (the key order of {@link RUNNER_STATE_WAIT_KIND}). */
export const RUNNER_STATE_ORDER = Object.keys(
  RUNNER_STATE_WAIT_KIND
) as ReadonlyArray<LiveRunnerState>;

/** True when `value` is a word a runner may say. */
export function isRunnerState(value: unknown): value is RunnerState {
  return (
    typeof value === "string" &&
    (RUNNER_STATES as readonly string[]).includes(value)
  );
}

/** The wait kind a runner's word gives; `null` for `ended`, none or an unknown word. */
export function runnerStateWaitKind(
  state: string | null | undefined
): WaitKind | null {
  return state && Object.hasOwn(RUNNER_STATE_WAIT_KIND, state)
    ? RUNNER_STATE_WAIT_KIND[state as LiveRunnerState]
    : null;
}

/** A word's urgency rank (0 = most urgent); `ended`, none or unknown rank last. */
export function runnerStateRank(state: string | null | undefined): number {
  const i = RUNNER_STATE_ORDER.indexOf(state as LiveRunnerState);
  return i === -1 ? RUNNER_STATE_ORDER.length : i;
}
