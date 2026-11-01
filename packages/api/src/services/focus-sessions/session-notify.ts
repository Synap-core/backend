/**
 * Two facts the session read carries for the person's surfaces (plan d679e92c
 * C9, wave 065982de W3-notify):
 *
 *   - `muted` — has the READER muted this session's pushes
 *     (`push_prefs.mutedSessions` on their pod-wide preferences row, written
 *     by tRPC `notifCenter.setSessionMute`)? The reader's own preference, so
 *     a teammate reading the same session sees their own answer.
 *   - `devboxJobs` — the devbox gate jobs run for this session: the
 *     `ci.finished` facts whose workflow is `devbox <name>`
 *     (`devboxJobOf`), posted by the devbox with the job's
 *     `GATE_POD_SESSION`. ONE item per job name, its newest run, newest first.
 *     "Of the session" is THE dev-fact rule (`sessionDevFactWhere`, the change
 *     feed's and the timeline's), under the events read floor.
 *
 * `continuation.gates.items` is NOT this: those are the stage gates of the
 * session's process, read from proposal rows (`session-gates.ts`).
 *
 * A FAILED read THROWS; the packet turns it into `{status:'unavailable'}`,
 * never into "not muted" or "no jobs".
 */

import {
  and,
  db as defaultDb,
  desc,
  drizzleSql,
  eq,
  events,
  isNull,
  notificationPreferences,
} from "@synap/database";
import {
  DEV_LOOP_EVENT_TYPES,
  ciVerdictOf,
  devboxJobOf,
} from "@synap-core/types";
import { isSessionPushMuted, normalizePushPrefs } from "@synap-core/types/push";
import { eventVisibleWhere } from "../../access/event-visibility.js";
import type { SessionReader } from "../../access/session-visibility.js";
import {
  sessionDevFactWhere,
  sessionPullRequestRefs,
} from "./session-changes.js";

type Database = typeof defaultDb;

/** Newest devbox runs read per session; the job list is folded from them. */
export const DEVBOX_JOB_RUNS_CAP = 100;
/** Jobs a packet lists; `total` is exact over the runs read. */
export const DEVBOX_JOBS_TOP_N = 5;
/** Gates kept per job, as the devbox posted them. */
const GATES_CAP = 30;
const TEXT_MAX = 128;

export type PacketMuted =
  { status: "ok"; muted: boolean } | { status: "unavailable"; reason: string };

/** One gate of a devbox job, as the devbox posted it (`{id, status}`). */
export interface PacketDevboxGate {
  /** The gate's name (`app-file`, `be-types`, …). */
  id: string;
  /** The devbox's own word for its result (`green`, `red`, `INFRA`, …). */
  status: string;
}

/** A devbox gate job of this session: its NEWEST run. */
export interface PacketDevboxJobItem {
  /** The job name (`devbox <name>` workflow). */
  job: string;
  repo: string;
  /** The commit the job checked, as posted (may be abbreviated). */
  sha: string;
  /** The run's status (`success`, `failure`, `cancelled`, …). */
  status: string;
  /** THE verdict (`ciVerdictOf`): null when the run settled nothing (cancelled, skipped). */
  verdict: "passed" | "failed" | null;
  /** The job's gates with their results; [] when the devbox posted none. */
  gates: PacketDevboxGate[];
  /** The run's page, when the devbox gave one; null otherwise (never a guess). */
  url: string | null;
  /** When the pod heard the run ended (ISO). */
  at: string;
  /** Runs of this job name among the runs read (≥ 1). */
  runs: number;
}

export type PacketDevboxJobsSection =
  | { status: "ok"; total: number; items: PacketDevboxJobItem[] }
  | { status: "unavailable"; reason: string };

/** Does `userId` mute this session's pushes? THROWS on a failed read. */
export async function readSessionMuted(
  database: Database,
  userId: string,
  sessionId: string
): Promise<boolean> {
  const [row] = await database
    .select({ pushPrefs: notificationPreferences.pushPrefs })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.userId, userId),
        isNull(notificationPreferences.workspaceId)
      )
    )
    .limit(1);
  return isSessionPushMuted(normalizePushPrefs(row?.pushPrefs), sessionId);
}

const clipText = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.slice(0, TEXT_MAX) : null;

function gatesOf(raw: unknown): PacketDevboxGate[] {
  if (!Array.isArray(raw)) return [];
  const out: PacketDevboxGate[] = [];
  for (const g of raw) {
    if (!g || typeof g !== "object") continue;
    const id = clipText((g as { id?: unknown }).id);
    const status = clipText((g as { status?: unknown }).status);
    if (id && status) out.push({ id, status });
    if (out.length >= GATES_CAP) break;
  }
  return out;
}

/** One row of the read, as {@link foldDevboxJobs} needs it. */
export interface DevboxRunRow {
  data: unknown;
  at: string;
}

/**
 * Pure: the runs (NEWEST FIRST) folded to one item per job, newest first.
 * A run that is not a devbox job, or lacks a repo or sha, is skipped.
 */
export function foldDevboxJobs(
  rowsNewestFirst: readonly DevboxRunRow[]
): PacketDevboxJobItem[] {
  const byJob = new Map<string, PacketDevboxJobItem>();
  for (const r of rowsNewestFirst) {
    const d = (r.data ?? {}) as Record<string, unknown>;
    const job = devboxJobOf(d.workflow);
    const repo = clipText(d.repo);
    const sha = clipText(d.sha);
    const status = clipText(d.status);
    if (!job || !repo || !sha || !status) continue;
    const seen = byJob.get(job);
    if (seen) {
      seen.runs++;
      continue;
    }
    byJob.set(job, {
      job,
      repo,
      sha,
      status,
      verdict: ciVerdictOf(status) ?? null,
      gates: gatesOf(d.gates),
      url:
        typeof d.url === "string" && /^https?:\/\//i.test(d.url) ? d.url : null,
      at: r.at,
      runs: 1,
    });
  }
  return [...byJob.values()];
}

/** The session's devbox jobs (see the header). THROWS on a failed read. */
export async function readSessionDevboxJobs(
  database: Database,
  reader: SessionReader,
  row: { id: string; expectedOutputs: unknown }
): Promise<{ total: number; items: PacketDevboxJobItem[] }> {
  const heardAt = drizzleSql`coalesce((${events.data}->>'ingestedAt')::timestamptz, ${events.timestamp})`;
  const rows = await database
    .select({
      data: events.data,
      at: drizzleSql<string>`to_char(${heardAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(events)
    .where(
      and(
        eq(events.type, DEV_LOOP_EVENT_TYPES.ciFinished),
        drizzleSql`${events.data}->>'workflow' LIKE 'devbox %'`,
        eventVisibleWhere({
          userId: reader.userId,
          roster: reader.roster ?? false,
          lens: reader.lens,
        })
      )
    )
    .orderBy(desc(events.timestamp))
    .limit(DEVBOX_JOB_RUNS_CAP);
  const jobs = foldDevboxJobs(rows);
  return { total: jobs.length, items: jobs.slice(0, DEVBOX_JOBS_TOP_N) };
}
