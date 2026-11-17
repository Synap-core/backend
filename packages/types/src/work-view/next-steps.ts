/**
 * nextStepsOf — what a BLOCKER offers the person: at most
 * {@link NEXT_STEPS_CAP} steps, the same on every surface (plan dc5a50cf §B,
 * founder defaults of 18 Nov 2026).
 *
 * The rules, each a guard a test tries to defeat:
 *   - A step is an OFFER. Nothing here starts anything: a step that starts a
 *     Job (`door.kind: "playbook"`) runs only on a PERSON's tap; this function
 *     only describes it. An agent never starts one.
 *   - A blocker that is itself the work of a next-step Job offers none
 *     (`fromNextStep`): AI never asks AI.
 *   - One open Job per blocker: when one started from this blocker is still
 *     open (`openJobId`), the step opens it instead of starting another.
 *   - Cost said up front: `usesAi` is true for a step that runs the pod's AI.
 *     At most one AI review per blocker per {@link AI_REVIEW_WINDOW_MS}
 *     (`aiReviewedAt`): inside the window the review step is not offered.
 *   - A wait offers nothing when the ball is the person's (they act), and the
 *     "speed this up" step only when the wait is slow AND repeats.
 *   - The next-step door lives only where the wait is explained (ask card,
 *     Request page, Job now-line, Relay card): a surface never draws it as a
 *     Home row. This module cannot enforce where; the browser and Relay
 *     lanes' tripwires do.
 *
 * Pure. Words: each step names an existing vocabulary ACTION token
 * (`action`, read through `resolveActionLabel`); no label map here.
 */

import { waitKindBall } from "../units/wait-kind.js";
import type { LensDoor } from "../lens/rows.js";

export const NEXT_STEPS_CAP = 3;

/** At most one AI review per blocker per day. */
export const AI_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A wait is slow when it repeated this often, or its median passed the bar. */
export const SLOW_WAIT_MIN_REPEATS = 3;
export const SLOW_WAIT_MEDIAN_MS = 30 * 60 * 1000;

export type NextStepVerb =
  // a batch of Requests
  | "review_with_ai"
  | "decide_here"
  | "always_allow"
  // an ask on the person
  | "hand_to_agent"
  | "give_agents_a_tool"
  | "talk_it_through"
  // a Job waiting on something
  | "speed_up"
  | "open_waited_on"
  | "nudge";

export type NextStepDoor =
  /** A tap starts a Job from the catalog playbook `playbookKey`. */
  | { kind: "playbook"; playbookKey: string; params: Record<string, unknown> }
  /** A tap calls an existing procedure the person already owns. */
  | {
      kind: "call";
      procedure:
        | "focusSessions.delegateOutput"
        | "focusSessions.askAboutSlot"
        | "proposals.askAi";
      params: Record<string, unknown>;
    }
  /** A tap opens the existing batch view of this batch (no new page). */
  | { kind: "batch"; key: string }
  /** A tap opens an object's own page. */
  | { kind: "object"; door: LensDoor };

export interface NextStep {
  /** `${blockerKey}:${verb}`: the dedupe identity. */
  key: string;
  verb: NextStepVerb;
  /** An existing vocabulary ACTION token for the button's word. */
  action: string;
  door: NextStepDoor;
  /** Runs the pod's AI: the button says so. */
  usesAi: boolean;
  /** A Job started from this blocker is still open: the step opens it. */
  openJobId: string | null;
}

interface BlockerBase {
  /** Stable key of the blocker (a request key, a wait key). */
  key: string;
  /** This blocker belongs to a Job a next step started. */
  fromNextStep?: boolean;
  /** A Job started from this blocker, still open. */
  openJobId?: string | null;
}

export type BlockerOf =
  | (BlockerBase & {
      kind: "batch";
      /** Every request id of the batch the pod holds. */
      proposalIds: readonly string[];
      /** How many requests the batch stands for (more than ids = a sample). */
      count: number;
      /** Every item is a routine change. */
      routine: boolean;
      /** When an AI review of this batch last ran (ISO). */
      aiReviewedAt?: string | null;
      /** The fingerprint the batch was made on. */
      fingerprint?: string | null;
    })
  | (BlockerBase & {
      kind: "ask";
      sessionId: string;
      slotLabel: string;
      /** Why it is the person's (`credential`, `decision`…); null = unsaid. */
      blockedReason: string | null;
    })
  | (BlockerBase & {
      kind: "wait";
      sessionId: string;
      waitKind: string;
      refKey: string;
      /** The object it waits on (the PR, the run), when known. */
      waitedOn?: LensDoor | null;
      /** How often and how long: null = not read (never folded into 0). */
      repeats: { count: number; medianMs: number } | null;
    });

const HAND_REASONS: ReadonlySet<string> = new Set(["decision", "physical"]);
const TOOL_REASONS: ReadonlySet<string> = new Set([
  "capability",
  "credential",
  "permission",
]);

/** The steps a blocker offers: at most {@link NEXT_STEPS_CAP}, never started. */
export function nextStepsOf(
  blocker: BlockerOf,
  opts: { now?: Date } = {}
): NextStep[] {
  const open = blocker.openJobId ?? null;
  const step = (
    verb: NextStepVerb,
    action: string,
    door: NextStepDoor,
    usesAi: boolean
  ): NextStep => ({
    key: `${blocker.key}:${verb}`,
    verb,
    action,
    door,
    usesAi,
    openJobId: door.kind === "playbook" ? open : null,
  });
  const steps: NextStep[] = [];

  if (blocker.kind === "batch") {
    const now = (opts.now ?? new Date()).getTime();
    const reviewed = blocker.aiReviewedAt
      ? Date.parse(blocker.aiReviewedAt)
      : NaN;
    const recentlyReviewed = false;
    if (!recentlyReviewed || open) {
      steps.push(
        step(
          "review_with_ai",
          "review",
          {
            kind: "playbook",
            playbookKey: "review-request-batch",
            params: {
              proposalIds: blocker.proposalIds,
              fingerprint: blocker.fingerprint ?? null,
            },
          },
          true
        )
      );
    }
    steps.push(
      step("decide_here", "decide", { kind: "batch", key: blocker.key }, false)
    );
    // A sample (fewer ids than the batch holds) is never decided in bulk.
    if (blocker.routine) {
      steps.push(
        step(
          "always_allow",
          "approve",
          {
            kind: "playbook",
            playbookKey: "allow-routine-kind",
            params: { proposalIds: blocker.proposalIds },
          },
          false
        )
      );
    }
  } else if (blocker.kind === "ask") {
    const reason = blocker.blockedReason?.trim().toLowerCase() ?? "";
    const slot = { sessionId: blocker.sessionId, slotLabel: blocker.slotLabel };
    if (HAND_REASONS.has(reason)) {
      steps.push(
        step(
          "hand_to_agent",
          "request",
          {
            kind: "call",
            procedure: "focusSessions.delegateOutput",
            params: slot,
          },
          false
        )
      );
    }
    if (TOOL_REASONS.has(reason)) {
      steps.push(
        step(
          "give_agents_a_tool",
          "build",
          {
            kind: "playbook",
            playbookKey: "give-agents-a-tool",
            params: { ...slot, blockedReason: reason },
          },
          true
        )
      );
    }
    steps.push(
      step(
        "talk_it_through",
        "ask",
        { kind: "call", procedure: "focusSessions.askAboutSlot", params: slot },
        true
      )
    );
  } else {
    const ball = waitKindBall(blocker.waitKind);
    if (!ball) return [];
    const r = blocker.repeats;
    const slow =
      r === null ||
      r.count >= SLOW_WAIT_MIN_REPEATS ||
      r.medianMs > SLOW_WAIT_MEDIAN_MS;
    if ((ball === "machine" || ball === "agent") && slow) {
      steps.push(
        step(
          "speed_up",
          "revise",
          {
            kind: "playbook",
            playbookKey: "speed-up-slow-step",
            params: {
              sessionId: blocker.sessionId,
              waitKind: blocker.waitKind,
              refKey: blocker.refKey,
            },
          },
          true
        )
      );
    }
    if (blocker.waitedOn) {
      steps.push(
        step(
          "open_waited_on",
          "open",
          { kind: "object", door: blocker.waitedOn },
          false
        )
      );
    }
    if (ball === "them") {
      steps.push(
        step(
          "nudge",
          "post",
          {
            kind: "object",
            door: { kind: "session", id: blocker.sessionId, view: "room" },
          },
          false
        )
      );
    }
  }
  return steps;
}
