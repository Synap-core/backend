/**
 * WAIT KINDS — what exactly a thing waits on, and whose move it is (decision 2
 * of the status foundation, report c3a662b2 §3 and §12).
 *
 * The finer axis beside the coarse waiting-on `reason` (`WAITING_ON_REASONS`,
 * `./goal.ts`) and a hold's `on` (`HOLD_ON`, `../lifecycle/hold.ts`). It never
 * replaces either, and it is never called `kind`: `WaitingOnRef.kind`,
 * `WaitingOnSource.kind` and `HoldDevRef.kind` already mean three other things.
 * So every field that carries it is `waitKind`.
 *
 * The BALL says whose move it is, and it is the first sort key of every
 * screen: `me` (the person reading), `them` (a person or party outside),
 * `agent`, `machine` (it moves by itself: CI, the queue, a job, a deploy),
 * `thing` (other work), `date` (the calendar), `nobody` (a deliberate park).
 *
 * ONE map table ({@link WAIT_KIND_FROM}) says which kind each existing value
 * gives: a hold's `on`, a hold's dev ref (`pr:` / `main:` / `job:`), an owed
 * slot's `blockedReason`, and the waiting-on source. The mapping FUNCTION is
 * `waitKindOf` (`./goal.ts`, beside `waitingOnReasonOf`).
 *
 * Pure and import-free at run time: `./state.ts` reads it, and Relay, the
 * browser and the CLI import `./state.ts`.
 */
import type { HoldDevRef, HoldOn } from "../lifecycle/hold.js";

/** Every wait kind, in the order of the taxonomy (c3a662b2 §3). */
export const WAIT_KINDS = [
  // the ball is yours
  "answer",
  "approval",
  "send",
  "try_it",
  "access",
  "decide",
  // the ball is theirs
  "their_reply",
  "their_document",
  "signature",
  "payment",
  "vendor",
  // an agent holds it
  "agent_work",
  "agent_stopped",
  // a machine holds it: it moves by itself
  "ci",
  "devbox_job",
  "merge_queue",
  "red_main",
  "deploy",
  // other work, the calendar, nobody
  "another_work",
  "date",
  "nobody",
] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

/** True when `value` is a wait kind this build knows. */
export function isWaitKind(value: unknown): value is WaitKind {
  return (
    typeof value === "string" &&
    (WAIT_KINDS as readonly string[]).includes(value)
  );
}

/** Whose move it is. */
export const WAIT_BALLS = [
  "me",
  "them",
  "agent",
  "machine",
  "thing",
  "date",
  "nobody",
] as const;
export type WaitBall = (typeof WAIT_BALLS)[number];

/** Each kind's ball. Keyed by EVERY kind: a kind with no ball stops the build. */
export const WAIT_KIND_BALL = {
  answer: "me",
  approval: "me",
  send: "me",
  try_it: "me",
  access: "me",
  decide: "me",
  their_reply: "them",
  their_document: "them",
  signature: "them",
  payment: "them",
  vendor: "them",
  agent_work: "agent",
  agent_stopped: "agent",
  ci: "machine",
  devbox_job: "machine",
  merge_queue: "machine",
  red_main: "machine",
  deploy: "machine",
  another_work: "thing",
  date: "date",
  nobody: "nobody",
} as const satisfies Record<WaitKind, WaitBall>;

/** The ball of a wait kind; an unknown kind has none. */
export function waitKindBall(
  waitKind: string | null | undefined
): WaitBall | null {
  return isWaitKind(waitKind) ? WAIT_KIND_BALL[waitKind] : null;
}

/**
 * THE map table: which wait kind each existing value gives. One row per value
 * of each axis, typed by every hold value; the slot reasons and the sources
 * are pinned row by row by `api/__tripwires__/waiting-on-blocked-reasons` and
 * `waiting-on-hold-reasons` (the closed sets live outside this package).
 *
 *  - `hold`: a pause's `on`. A hold on a person is the person's input, as
 *    `HOLD_ON_WAITING_ON` already reads it ("the founder's go"); a party
 *    outside is `external`, and a step names its own kind ("their_reply",
 *    "signature") through `waits.waitKind`. On `unspecified` (a person's
 *    pause that said nothing) it names no wait, so it reads as a park.
 *  - `dev`: a hold whose `until.moves` names a dev fact. It outranks `on`:
 *    `pr:` waits on the PR's checks and landing, `main:` on a red main,
 *    `job:` on a devbox job.
 *  - `blockedReason`: an owed slot's class of blocker; `none` = a slot with
 *    no reason (a question, a param, an ask).
 *  - `source`: what the pod found the wait in (`WaitingOnSource`); a work
 *    unit splits by its checks (`ci` while they run, `merge_queue` once
 *    green), and `owed_slot` / `hold` defer to their own axis. A `step` (a
 *    lifecycle option's declared `waits`) gives its own `waitKind`, else
 *    defers to the `hold` axis by its `on`.
 */
export const WAIT_KIND_FROM = {
  hold: {
    person: "answer",
    agent: "agent_work",
    external: "vendor",
    thing: "another_work",
    decision: "decide",
    date: "date",
    nobody: "nobody",
    unspecified: "nobody",
  },
  dev: {
    pr: "ci",
    main: "red_main",
    job: "devbox_job",
  },
  blockedReason: {
    credential: "access",
    permission: "access",
    capability: "access",
    policy: "access",
    decision: "decide",
    // An owed slot is the PERSON's (`owner: 'human'`): a physical act is
    // theirs to do in the world, so it is their move, never an outside
    // party's. (The goal's waiting-on reason still says `outside_world`.)
    physical: "answer",
    none: "answer",
  },
  source: {
    pending_proposal: "approval",
    blocked_by: "another_work",
    child_session: "another_work",
    work_unit_checks: "ci",
    work_unit_green: "merge_queue",
  },
} as const satisfies {
  hold: Record<HoldOn, WaitKind>;
  dev: Record<HoldDevRef["kind"], WaitKind>;
  blockedReason: Record<string, WaitKind>;
  source: Record<string, WaitKind>;
};
