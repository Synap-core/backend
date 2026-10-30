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
 *                 facts of its PRs and devbox jobs (`dev.pr_*`, `ci.finished`)
 *                 and the decisions filed in it;
 *   pull_request  the dev facts about it (`dev.pr_*`, the CI runs on its
 *                 heads).
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
import type { TrackHistoryEvent } from "./track-history.js";

export const TIMELINE_SUBJECT_KINDS = [
  "goal",
  "session",
  "pull_request",
] as const;
export type TimelineSubjectKind = (typeof TIMELINE_SUBJECT_KINDS)[number];

export const DEV_TIMELINE_EVENT_KINDS = [
  "session_started",
  "status_moved",
  "pr_opened",
  "pr_merged",
  "pr_closed",
  "checks_finished",
  "decision_asked",
  "decision_answered",
] as const;
export type DevTimelineEventKind = (typeof DEV_TIMELINE_EVENT_KINDS)[number];

/** Doors the event names — each opens that object's own page. */
export interface DevTimelineRefs {
  sessionId?: string;
  proposalId?: string;
  /** A pull request or a CI run's page. */
  url?: string;
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
