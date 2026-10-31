/**
 * THE NEXT MOVE of a thing and of a goal (status-first foundation, PR-N): the
 * same `ContinuationNextMove` a session carries (`deriveNextMove`, the packet
 * rule), from the facts `statusOf` already reads — never a second shape and
 * never a second read. Pure.
 *
 * The rungs share the session rule's vocabulary: a pause is the session's own
 * hold rung ({@link holdNextMove}, rung 2c, one function for both); an owed
 * slot is `owed_slot`, a pending proposal `pending_proposal`, a session waited
 * on `waiting_on_session`, an ended one `none`, and a read that failed
 * `unknown`. Four kinds are added where none fitted: `waiting_on` (a wait on
 * someone or something, its `waitKind` saying whose ball), `step` (the next
 * step on the thing's own path, its `to` the option a move targets),
 * `judge_review` (a goal's claims wait on its judge) and `start_work` (a goal
 * no open session works on).
 *
 * The actor stays the packet's (`user` = the person reading, `ai`, `none`):
 * a wait on another person is `none`, the person named in the label and the
 * ball in `waitKind` (`them`).
 */
import {
  stepsFromLifecycle,
  type LifecycleCategory,
  type LifecycleOption,
  type RecordedHold,
} from "@synap-core/types/lifecycle";
import {
  WAIT_BALLS,
  WAIT_KIND_BALL,
  isWaitKind,
  type GoalCriterionMark,
  type WaitBall,
  type WaitKind,
  type WaitingOnMark,
  type WaitingOnRef,
} from "@synap-core/types/units";
import { resolveWaitingOnReasonLabel } from "@synap-core/types/vocabulary";
import type { ContinuationNextMove } from "../focus-sessions/continuation-packet.js";

/** What a subject is called in a move's reason. */
type Noun = "session" | "thing" | "goal";

const UNKNOWN = (reason: string): ContinuationNextMove => ({
  kind: "unknown",
  actor: "none",
  label: "Next move unknown",
  reason,
});

/**
 * Rung 2c of THE packet rule, for anything paused under a hold: the move is
 * what the hold waits on, never the work (actor none). `ref` is the hold's
 * waiting-on ref (`holdWaitingOnRef`, `status-facts.ts`).
 */
export function holdNextMove(
  hold: RecordedHold,
  ref: WaitingOnRef,
  noun: Noun
): ContinuationNextMove {
  const until = hold.until;
  const parked = hold.on === "nobody" || hold.on === "unspecified";
  const why = hold.reason?.trim() ? `: ${hold.reason.trim()}` : "";
  const resumes =
    until && "date" in until
      ? `It resumes on its own on ${until.date.slice(0, 10)}.`
      : until && "moves" in until
        ? "It resumes on its own when what it waits on moves."
        : hold.reviewBy
          ? `It resumes when someone resumes it, and is due for a look by ${hold.reviewBy.slice(0, 10)}.`
          : "It resumes when someone resumes it.";
  return {
    kind: "waiting_on_hold",
    actor: "none",
    label: parked
      ? "Paused"
      : until && "date" in until && hold.on === "date"
        ? `Paused until ${until.date.slice(0, 10)}`
        : `Waiting on ${ref.label}`,
    reason: `This ${noun} is paused${why}. ${resumes}`,
    ...(ref.kind === "session" && ref.id ? { sessionId: ref.id } : {}),
  };
}

/**
 * The current hold of a paused subject as the next move reads it: `null` =
 * none recorded, `unavailable` = the read failed (the move is then unknown).
 */
export type NextMoveHoldFact =
  { hold: RecordedHold; ref: WaitingOnRef } | null | "unavailable";

/** The paused rung: the hold's wait, a bare pause, or unknown. */
function pausedMove(hold: NextMoveHoldFact, noun: Noun): ContinuationNextMove {
  if (hold === "unavailable") {
    return UNKNOWN(`What this paused ${noun} waits on could not be read.`);
  }
  if (hold) return holdNextMove(hold.hold, hold.ref, noun);
  return {
    kind: "waiting_on_hold",
    actor: "none",
    label: "Paused",
    reason: `This ${noun} is paused, and no hold says what it waits on. It resumes when someone resumes it.`,
  };
}

function endedMove(noun: Noun, label: string | null): ContinuationNextMove {
  return {
    kind: "none",
    actor: "none",
    label: "Nothing to do",
    reason: `This ${noun} has ended${label ? ` (${label})` : ""}: nothing waits on a move.`,
  };
}

type NamedRef = WaitingOnRef & { waitKind: WaitKind };

/**
 * The ref a subject leads with: the named one whose ball comes first in
 * `WAIT_BALLS` (yours, theirs, an agent's, a machine's, other work, a date,
 * nobody), in source order within a ball — `leadWaitKind`'s order, keeping
 * the ref. `null` when no ref names a kind.
 */
export function leadWaitRef(
  marks: readonly WaitingOnMark[],
  balls: readonly WaitBall[] = WAIT_BALLS
): NamedRef | null {
  let best: NamedRef | null = null;
  let bestRank = Infinity;
  for (const m of marks) {
    for (const r of m.refs ?? []) {
      if (!isWaitKind(r.waitKind)) continue;
      const ball = WAIT_KIND_BALL[r.waitKind];
      if (!balls.includes(ball)) continue;
      const rank = WAIT_BALLS.indexOf(ball);
      if (rank < bestRank) {
        best = r as NamedRef;
        bestRank = rank;
      }
    }
  }
  return best;
}

const BALL_REASON: Record<WaitBall, (noun: Noun) => string> = {
  me: (n) => `This ${n} waits on you: nothing moves until you act.`,
  them: (n) =>
    `This ${n} waits on someone outside: nothing here moves until they do.`,
  agent: (n) => `An agent holds this ${n}'s next step.`,
  machine: (n) =>
    `This ${n} moves by itself when the machine it waits on finishes (CI, the queue, a job, a deploy).`,
  thing: (n) => `This ${n} waits on other work.`,
  date: (n) => `This ${n} waits on a date.`,
  nobody: (n) => `This ${n} is parked: nobody is asked to move it.`,
};

/** The move one named wait asks for. */
function waitMove(ref: NamedRef, noun: Noun): ContinuationNextMove {
  const ball = WAIT_KIND_BALL[ref.waitKind];
  const name = ref.label;
  if (ball === "me" && ref.kind === "proposal" && ref.id) {
    return {
      kind: "pending_proposal",
      actor: "user",
      label: `Review "${name}"`,
      reason: `A proposal about this ${noun} waits on your decision.`,
      proposalId: ref.id,
      waitKind: ref.waitKind,
    };
  }
  if (ball === "me" && ref.kind === "slot") {
    return {
      kind: "owed_slot",
      actor: "user",
      label: `Provide "${name}"`,
      reason: `A session working on this ${noun} handed this to you and is waiting on it.`,
      ...(ref.id ? { sessionId: ref.id } : {}),
      waitKind: ref.waitKind,
    };
  }
  const actor: ContinuationNextMove["actor"] =
    ball === "me" ? "user" : ball === "agent" ? "ai" : "none";
  if (ball !== "me" && ref.kind === "session" && ref.id) {
    return {
      kind: "waiting_on_session",
      actor,
      label: `Waiting on "${name}"`,
      reason: BALL_REASON[ball](noun),
      sessionId: ref.id,
      waitKind: ref.waitKind,
    };
  }
  return {
    kind: "waiting_on",
    actor,
    label: ball === "me" ? `Your move: ${name}` : `Waiting on ${name}`,
    reason: BALL_REASON[ball](noun),
    waitKind: ref.waitKind,
    ...(ref.id &&
    (ref.kind === "person" || ref.kind === "thing" || ref.kind === "decision")
      ? { entityId: ref.id }
      : {}),
    ...(ref.kind === "session" && ref.id ? { sessionId: ref.id } : {}),
    ...(ref.url ? { url: ref.url } : {}),
  };
}

/** A wait the pod counted without naming it (a reader may not see what). */
function unnamedWaitMove(
  mark: WaitingOnMark,
  noun: Noun
): ContinuationNextMove {
  const words = resolveWaitingOnReasonLabel(mark.reason);
  return {
    kind: "waiting_on",
    actor: "none",
    label: `Waiting on ${words.toLowerCase()}`,
    reason: `This ${noun} waits on ${mark.count === 1 ? "something" : `${mark.count} things`} the pod counted but you may not see.`,
  };
}

/** The stuck note a move's reason carries, when its step calls it stuck. */
function withStuck(
  move: ContinuationNextMove,
  stuck: { afterDays: number; forDays: number } | undefined
): ContinuationNextMove {
  if (!stuck) return move;
  return {
    ...move,
    reason: `${move.reason} It has stood in this step ${stuck.forDays} days; its step calls that stuck after ${stuck.afterDays}.`,
  };
}

export interface ThingNextMoveInput {
  /** Its declared lifecycle (a thing without one gets no next move). */
  lifecycle: { readonly options: readonly LifecycleOption[] };
  status: string | null;
  category: LifecycleCategory | null;
  /** The words of its status, for an ended thing's reason. */
  label: string | null;
  stuck?: { afterDays: number; forDays: number };
  waitingOn: readonly WaitingOnMark[] | "unavailable";
  /** Read for a paused thing only. */
  hold: NextMoveHoldFact;
}

/**
 * A thing's next move. In order:
 *  1. `none` once it has ended (a done or lost status);
 *  2. a pause: its hold's wait ({@link holdNextMove}), a bare pause, or
 *     `unknown` when the hold could not be read;
 *  3. what it waits on, by ball (yours first): a proposal to review, a slot
 *     to provide, a session, or any other wait (`waiting_on`); a wait the
 *     reader may not see is still a wait. An unread waiting-on is `unknown`;
 *  4. its next MAIN-PATH step (`step`, `to` = the option): "Your move" when
 *     only a person may move it there (`humanOnly`), else the next step;
 *  5. `unknown` when its status is not one its lifecycle declares, `none`
 *     when its path has no step left.
 * A stuck thing's move says so in its reason.
 */
export function deriveThingNextMove(
  input: ThingNextMoveInput
): ContinuationNextMove {
  const { category } = input;
  if (category === "done" || category === "lost") {
    return endedMove("thing", input.label);
  }
  if (category === "paused") return pausedMove(input.hold, "thing");
  if (input.waitingOn === "unavailable") {
    return UNKNOWN("What this thing waits on could not be read.");
  }
  const lead = leadWaitRef(input.waitingOn);
  if (lead) return withStuck(waitMove(lead, "thing"), input.stuck);
  if (input.waitingOn[0]) {
    return withStuck(unnamedWaitMove(input.waitingOn[0], "thing"), input.stuck);
  }
  const steps = stepsFromLifecycle(input.lifecycle, input.status);
  const at = steps.findIndex((s) => s.position === "current");
  if (at < 0) {
    return UNKNOWN(
      "Its status is not one its lifecycle declares, so its next step is not known."
    );
  }
  const next = steps.slice(at + 1).find((s) => s.position === "ahead");
  if (!next) {
    return {
      kind: "none",
      actor: "none",
      label: "Nothing to do",
      reason: "Its path has no step left after this one.",
    };
  }
  const move: ContinuationNextMove = next.humanOnly
    ? {
        kind: "step",
        actor: "user",
        label: `Your move: ${next.label}`,
        reason: `Its next step is "${next.label}", and only a person may move it there.`,
        to: next.key,
      }
    : {
        kind: "step",
        actor: "user",
        label: `Next: ${next.label}`,
        reason: `Nothing waits on anyone; its next step is "${next.label}", once the work there is done.`,
        to: next.key,
      };
  return withStuck(move, input.stuck);
}

export interface GoalNextMoveFacts {
  /** What it waits on (THE collector, a container question). */
  waitingOn: readonly WaitingOnMark[];
  criteria: ReadonlyArray<{
    required?: boolean | null;
    mark: GoalCriterionMark | null;
  }>;
  /** Every required criterion claimed or met, one claimed (`goalInReview`). */
  inReview: boolean;
  /** Its open runs (sessions filed into it), every member's. */
  openRuns: number;
  /** Who judges it (the judge seat, else the owner). */
  judge: { id: string; name: string | null } | null;
}

export interface GoalNextMoveInput {
  category: LifecycleCategory | null;
  label: string | null;
  hold: NextMoveHoldFact;
  facts: GoalNextMoveFacts | "unavailable";
  /**
   * Open sessions in its tree (`include: ["rollup"]`), filed in or serving;
   * absent ⇒ its own open runs count.
   */
  treeOpenSessions?: number;
  /** The person reading: is the judge's move theirs. */
  readerId: string;
}

/**
 * A goal's next move. In order:
 *  1. `none` once it has ended; 2. a pause (as a thing's);
 *  3. `unknown` when its facts could not be read;
 *  4. a wait whose ball is YOURS (a slot its runs owe you, a proposal);
 *  5. `judge_review` while its claims wait on its judge (actor `user` when
 *     the reader judges it, else `none`, the judge named);
 *  6. `ready_to_close` when every required criterion is met: the judge's
 *     to close;
 *  7. any other wait (an agent's, someone outside, a machine…);
 *  8. `start_work` when no open session works on it ("Start work on it"),
 *     else `waiting_on_session` (its work is under way).
 */
export function deriveGoalNextMove(
  input: GoalNextMoveInput
): ContinuationNextMove {
  const { category, facts } = input;
  if (category === "done" || category === "lost") {
    return endedMove("goal", input.label);
  }
  if (category === "paused") return pausedMove(input.hold, "goal");
  if (facts === "unavailable") {
    return UNKNOWN("This goal's criteria and waits could not be read.");
  }
  const mine = leadWaitRef(facts.waitingOn, ["me"]);
  if (mine) return waitMove(mine, "goal");

  const judgeIsReader = facts.judge?.id === input.readerId;
  const judgeName = facts.judge?.name?.trim() || "its judge";
  if (facts.inReview) {
    const claimed = facts.criteria.filter((c) => c.mark === "claimed").length;
    const what = `${claimed} claimed criteri${claimed === 1 ? "on" : "a"}`;
    return judgeIsReader
      ? {
          kind: "judge_review",
          actor: "user",
          label: `Judge ${what}`,
          reason: `Every required criterion is claimed or met; you judge this goal, so the claims wait on you.`,
        }
      : {
          kind: "judge_review",
          actor: "none",
          label: `Waiting on ${judgeName} to judge ${what}`,
          reason: `Every required criterion is claimed or met; ${judgeName} judges this goal.`,
        };
  }
  const required = facts.criteria.filter((c) => c.required !== false);
  if (required.length > 0 && required.every((c) => c.mark === "met")) {
    return judgeIsReader
      ? {
          kind: "ready_to_close",
          actor: "user",
          label: "Close the goal",
          reason:
            "Every required criterion is met; you judge this goal, so closing it is yours.",
        }
      : {
          kind: "ready_to_close",
          actor: "none",
          label: `Waiting on ${judgeName} to close it`,
          reason: `Every required criterion is met; ${judgeName} judges this goal and closes it.`,
        };
  }
  const other = leadWaitRef(facts.waitingOn);
  if (other) return waitMove(other, "goal");
  if (facts.waitingOn[0]) return unnamedWaitMove(facts.waitingOn[0], "goal");

  const open = input.treeOpenSessions ?? facts.openRuns;
  if (open === 0) {
    return {
      kind: "start_work",
      actor: "user",
      label: "Start work on it",
      reason:
        input.treeOpenSessions === undefined
          ? "No open session is filed into this goal: start one, yourself or by asking an agent."
          : "No open session works on this goal or its sub-goals: start one, yourself or by asking an agent.",
    };
  }
  return {
    kind: "waiting_on_session",
    actor: "none",
    label: `Work under way in ${open} session${open === 1 ? "" : "s"}`,
    reason:
      "Its sessions are open and nothing in them waits on anyone; the next move comes from their work.",
  };
}
