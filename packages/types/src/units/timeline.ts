/**
 * THE TIMELINE — what happened to a goal, a session or a pull request, newest
 * first, as the pod reads it (Hub `GET /timeline`, MCP `synap_get_timeline`;
 * api `services/timeline/read-timeline.ts`).
 *
 * One door, three subjects, each from the sources that are honest for it:
 *   goal          the goal history (`tracks.history`, `TrackHistoryEvent`):
 *                 step moves, checks, its sessions, decisions, status moves;
 *   session       its start, its status moves with their holds (the
 *                 transition log, `lifecycle_transition_outbox`), the dev
 *                 facts of its PRs and devbox jobs (`dev.pr_*`, `ci.finished`),
 *                 the decisions filed in it, and what happened to its slots'
 *                 asks (asked, answered, attested, a relay corrected, a
 *                 question withdrawn: the `focus_session.slot_*` history rows);
 *   pull_request  the dev facts about it (`dev.pr_*`, the CI runs on its
 *                 heads);
 *   entity        a thing's status moves and its visible roles' (the
 *                 transition log). Read through `statusOf`'s
 *                 `include: ["history"]`; no door names it on its own.
 *
 * TIME: `at` is when the thing HAPPENED (a move's `occurredAt`, a fact's
 * occurred time). `recordedAt` is present only where the pod recorded it
 * later than that (a backdated move, a webhook that arrived late): a surface
 * shows it as "recorded at". Actors are named by the POD.
 *
 * PURE and dependency-light (Relay, browser and pod read the same contract).
 */

import type { ActivityActor } from "../activity/index.js";
import type { CiFinishedStatus } from "../events/dev-loop.js";
import type { PullRequestChecks } from "../events/pr-state.js";
import type { LifecycleCategory } from "../lifecycle/option.js";
import type { RecordedHold } from "../lifecycle/hold.js";
import type { TransitionCause } from "../lifecycle/index.js";
import type { TrackHistoryEvent } from "./track-history.js";

export const TIMELINE_SUBJECT_KINDS = [
  "goal",
  "session",
  "pull_request",
] as const;
export type TimelineSubjectKind = (typeof TIMELINE_SUBJECT_KINDS)[number];

/**
 * The session's CHAIN kinds (founder decision D3, plan b38bc224): what the
 * Operations session lens shows beyond the dev facts and asks. Only a session
 * timeline carries them; the request story leaves them out.
 */
export const SESSION_CHAIN_EVENT_KINDS = [
  "stage_moved",
  "child_started",
  "runner_seen",
  "room_post",
] as const;
export type SessionChainEventKind = (typeof SESSION_CHAIN_EVENT_KINDS)[number];

export const DEV_TIMELINE_EVENT_KINDS = [
  "session_started",
  "status_moved",
  "pr_opened",
  "pr_merged",
  "pr_closed",
  "checks_finished",
  "decision_asked",
  "decision_answered",
  "slot_asked",
  "slot_answered",
  "slot_attested",
  "relay_corrected",
  "question_withdrawn",
  "slot_handed_back",
  ...SESSION_CHAIN_EVENT_KINDS,
] as const;
export type DevTimelineEventKind = (typeof DEV_TIMELINE_EVENT_KINDS)[number];

/** Doors the event names — each opens that object's own page. */
export interface DevTimelineRefs {
  sessionId?: string;
  proposalId?: string;
  /** A pull request or a CI run's page. */
  url?: string;
  /** The session slot an ask event is about (its label): a door to the ask. */
  slotLabel?: string;
  /** A room post: the message (open the room at it). */
  messageId?: string;
  /** A room post: the room it sits in. */
  channelId?: string;
  /** A runner: `<harness>:<conversation id>`, the conversation it is. */
  runnerId?: string;
}

/** Characters of a room post's one line; longer text ends in "…". */
export const TIMELINE_POST_LINE_MAX = 120;

/**
 * A room post as ONE line: its first non-empty line, whitespace collapsed, at
 * most {@link TIMELINE_POST_LINE_MAX} characters (cut ending in "…"). The
 * timeline never carries a post's body: the room is the door to it. Pure.
 */
export function timelinePostLine(text: string): {
  line: string;
  truncated: boolean;
} {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);
  const first = lines[0] ?? "";
  const chars = [...first];
  if (chars.length > TIMELINE_POST_LINE_MAX) {
    return {
      line: `${chars
        .slice(0, TIMELINE_POST_LINE_MAX - 1)
        .join("")
        .trimEnd()}…`,
      truncated: true,
    };
  }
  return { line: first, truncated: lines.length > 1 };
}

/** Below this, a record time is the occurrence time (no "recorded at"). */
export const TIMELINE_RECORDED_LATE_MS = 1_000;

interface DevTimelineEventBase {
  /** Stable across reads — a client may key rows by it. */
  id: string;
  /** When it happened (ISO-8601). */
  at: string;
  /** When the pod recorded it, only when later than `at` by 1 s or more. */
  recordedAt?: string;
  /** Who acted, named by the pod. A producer's fact is `system`. */
  actor: ActivityActor;
  refs: DevTimelineRefs;
}

export type DevTimelineEvent = DevTimelineEventBase &
  (
    | { kind: "session_started"; title: string }
    | {
        kind: "status_moved";
        from: string | null;
        to: string;
        category: LifecycleCategory;
        reason: string | null;
        /** What a pause waits on and how it resumes; null for any other move. */
        hold: RecordedHold | null;
        /** A thing's ROLE moved (its slug); absent for its own status. */
        role?: string;
        /**
         * Another move caused this one (a rule fired on it): the rule, the move
         * that fired it, its chain and depth. Absent on a move nobody's move
         * caused. "Moved because X moved."
         */
        cause?: TransitionCause;
      }
    | {
        kind: "pr_opened" | "pr_merged" | "pr_closed";
        pr: { repo: string; number: number; url: string; title: string | null };
        /** A merge into the default branch; null when the fact did not say. */
        intoDefault: boolean | null;
      }
    | {
        kind: "checks_finished";
        checks: {
          repo: string;
          sha: string;
          /** null: the run settled nothing (cancelled, skipped, neutral). */
          result: PullRequestChecks | null;
          status: CiFinishedStatus;
          pr: number | null;
          /** The devbox job (a `devbox <name>` run); null for a CI workflow. */
          job: string | null;
          workflow: string | null;
        };
      }
    | { kind: "decision_asked"; title: string | null }
    | {
        kind: "decision_answered";
        title: string | null;
        /** `approved` | `rejected` | `reverted` | `approval_failed`. */
        decision: string;
        note: string | null;
      }
    | {
        /** An agent (or the pod) posed an ask to the person on a slot. */
        kind: "slot_asked";
        /** The slot's label, as the agent wrote it. */
        slot: string;
        /** The ask's mode (`confirm`, `choose`, `form`, `act`, `provide`); null = a bare hand-over. */
        askMode: string | null;
        /** The class of what unblocks it (`credential`, `decision`…); null = not said. */
        blockedReason: string | null;
      }
    | {
        /** The person answered the ask on a slot. An answer is input, never a delivery. */
        kind: "slot_answered";
        slot: string;
        /** The typed answer's `type` (`confirm`, `chip`, `form`, `provide`, `text`…); null = free text. A string: a newer pod may answer a type this build does not know. */
        answerType: string | null;
        /** The slot went back to the agent with the answer. */
        handedBack: boolean;
        /** An agent relayed the person's words from a chat. */
        relayed: boolean;
      }
    | {
        /** The person said "I did this" about a slot they owed: it is delivered. */
        kind: "slot_attested";
        slot: string;
      }
    | {
        /** The person said "Not what I said" about a relayed answer: the ask is theirs again. */
        kind: "relay_corrected";
        /** null when the relay named no slot. */
        slot: string | null;
      }
    | {
        /** The agent took back a question it asked the person. */
        kind: "question_withdrawn";
        slot: string | null;
        /** The agent's reason, as written; null = none given. */
        note: string | null;
      }
    | {
        /** The person said "Not mine" about a slot an agent handed them: it is the agent's again, unanswered. */
        kind: "slot_handed_back";
        slot: string;
      }
    | {
        /** The session entered a stage (`focus_sessions.stage_history`). */
        kind: "stage_moved";
        /** The stage key it left; null = it had none. */
        from: string | null;
        to: string;
        /** The stage door (`advance`) or a re-applied approval. */
        via: string;
      }
    | {
        /** The session spawned a child (its `spawned_from` link). */
        kind: "child_started";
        child: { id: string; title: string; status: string };
      }
    | {
        /**
         * A runner (one process of a client conversation) first held this
         * session (`session_runners.first_seen_at`). Its state now, not a
         * history of states.
         */
        kind: "runner_seen";
        runner: {
          /** `claude-code`, `codex`… */
          harness: string;
          conversationId: string;
          /** The computer: its pod name, else the host the process named; null = unknown. */
          computer: string | null;
          /** As its client names it; null = unknown. */
          model: string | null;
          provider: string | null;
          /** What it last said it is doing (`busy`, `idle`…); null = it names none. */
          state: string | null;
          lastSeenAt: string;
        };
      }
    | {
        /**
         * A post in the session's room, or one it sent to another session's
         * room: ONE line, never the body (decision D3). `refs.messageId` and
         * `refs.channelId` open the room at it.
         */
        kind: "room_post";
        post: {
          /**
           * `person`: a person typed it. `question` / `update`: an agent's
           * post (a question notifies the person). `session_message`: a
           * coordination post between sessions (`direction`, `intent`).
           */
          form: "person" | "question" | "update" | "session_message";
          /** A session_message: received (`in`) or sent (`out`); else null. */
          direction: "in" | "out" | null;
          /** A session_message's intent (`handoff`, `fyi`…); else null. */
          intent: string | null;
          /** {@link timelinePostLine}: at most 120 characters. */
          line: string;
          /** The post holds more than its line. */
          truncated: boolean;
        };
      }
  );

/** The `GET /timeline` read. Newest first. */
export type TimelineWire =
  | {
      subject: { kind: "goal"; id: string };
      events: TrackHistoryEvent[];
      /** A source hit its scan cap — older events exist and are not listed. */
      truncated: boolean;
    }
  | {
      subject: { kind: "session"; id: string; title: string };
      events: DevTimelineEvent[];
      truncated: boolean;
    }
  | {
      subject: { kind: "entity"; id: string; title: string | null };
      events: DevTimelineEvent[];
      truncated: boolean;
    }
  | {
      subject: {
        kind: "pull_request";
        repo: string;
        number: number;
        url: string;
      };
      events: DevTimelineEvent[];
      truncated: boolean;
    };

/** `recordedAt` when the pod recorded it late, else nothing (the wire rule). */
export function timelineRecordedAt(
  at: string,
  recordedAt: string | null | undefined
): { recordedAt?: string } {
  if (!recordedAt) return {};
  const late = Date.parse(recordedAt) - Date.parse(at);
  return Number.isFinite(late) && late >= TIMELINE_RECORDED_LATE_MS
    ? { recordedAt: new Date(recordedAt).toISOString() }
    : {};
}
