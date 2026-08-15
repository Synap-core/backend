/**
 * Run STALL classification — "is this run hung?", not "is this run old?".
 *
 * THE DEFECT THIS FIXES. `stuck_runs` had exactly ONE signal: age past a flat
 * 24h boundary, applied identically to every flow type. Age is the easy thing
 * to measure; it is not the true thing. Verified live 2026-08-16: a session run
 * sat `status=running` from 18:40 with no completion while `synap_diagnose`
 * reported "No stuck runs" — because it was younger than a day. A run that has
 * made no progress for an hour is hung whether it started an hour ago or a
 * minute ago, and a session that IS progressing is healthy at 30h.
 *
 * SO THERE ARE TWO SIGNALS, and they mean different things:
 *
 *   AGED  — running past the age boundary. Unchanged, `degraded`. This is what
 *           the section always reported, kept verbatim so no consumer's meaning
 *           moves under it.
 *   IDLE  — a KNOWN `lastActivityAt` that has not moved for IDLE_STALL_MINUTES.
 *           `attention`, because a quiet run is suspicious, not proven dead.
 *
 * WHY IDLE'S BOUNDARY IS TIGHTER THAN THE REAPERS'. `playbook-run-reaper` waits
 * a full 24h before force-failing an idle run, deliberately: force-failing is
 * DESTRUCTIVE and a false positive abandons live work. REPORTING is not
 * destructive — the cost of a false "worth a look" is a glance. So reporting
 * can and should fire far earlier than acting. The boundary is nonetheless
 * borrowed rather than invented: `REAPER_STALE_MINUTES` is this repo's existing
 * "presumed orphaned" window for a run showing no progress.
 *
 * WHAT MAKES A RUN GO GREEN AGAIN (no always-red, no reset, no watermark):
 *   • it reaches a terminal status and leaves the `running` set entirely, or
 *   • its `lastActivityAt` advances — one real step and idle is cleared.
 * Both are ordinary consequences of the run working. Nothing here latches.
 *
 * WHAT IT REFUSES TO GUESS. `lastActivityAt: null` (automation, capture,
 * capability, agent_write) means the ledger records NO progress timestamp. Such
 * a run is never called idle — inventing activity from a proxy would be the
 * same defect wearing a different hat. `unobservable` counts them so the report
 * states how many runs it cannot judge, instead of folding them into a clean
 * "no stuck runs". Automation is covered elsewhere and honestly:
 * `automation-run-reaper` force-fails an orphan within 45min (delay-node
 * exemption included, which diagnose could not reproduce), and the reaped run
 * then appears under `failed_flows`.
 */

import { REAPER_STALE_MINUTES } from "@synap/jobs/workers/automation-run-reaper.js";
import type { FlowType } from "../runs/types.js";

const MINUTE_MS = 60 * 1000;

/**
 * No-progress window. Borrowed from the automation reaper's "presumed orphaned"
 * constant rather than minted, so this file never becomes a second, drifting
 * definition of "stalled". Env-overridable for operators whose sessions are
 * legitimately slower.
 */
export const IDLE_STALL_MINUTES = resolveIdleStallMinutes();

function resolveIdleStallMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DIAGNOSE_IDLE_STALL_MINUTES;
  if (raw === undefined || raw === "") return REAPER_STALE_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return REAPER_STALE_MINUTES;
  return n;
}

/** One running run, reduced to what the classifier needs. */
export interface StallCandidate {
  id: string;
  flowType: FlowType;
  flowName: string;
  startedAt: Date;
  lastActivityAt: Date | null;
}

export type StallVerdict = "ok" | "idle" | "aged";

export interface StalledRun {
  id: string;
  flowType: FlowType;
  flowName: string;
  ageHours: number;
  /** Minutes since the last progress evidence; null when unobservable. */
  idleMinutes: number | null;
  verdict: Exclude<StallVerdict, "ok">;
}

/**
 * PURE. `aged` outranks `idle` — an old run that is ALSO idle is reported once,
 * at the more severe verdict, so the two lists never double-count the same run.
 */
export function classifyRunStall(
  run: StallCandidate,
  now: number,
  opts: { agedHours: number; idleMinutes: number }
): StallVerdict {
  const ageHours = (now - run.startedAt.getTime()) / (60 * MINUTE_MS);
  if (ageHours > opts.agedHours) return "aged";
  if (run.lastActivityAt === null) return "ok"; // UNKNOWN, never "no activity"
  const idleMinutes = (now - run.lastActivityAt.getTime()) / MINUTE_MS;
  return idleMinutes > opts.idleMinutes ? "idle" : "ok";
}

export interface StallReport {
  /** Running past the age boundary — the historical `stuck` list, verbatim. */
  aged: StalledRun[];
  /** Known-idle: progress evidence exists and has not moved. */
  idle: StalledRun[];
  /**
   * Running runs whose ledger carries NO progress timestamp, so idleness is
   * UNJUDGEABLE for them. Reported as a count so the section can say what it
   * could not see rather than implying it saw nothing wrong.
   */
  unobservable: number;
}

/** PURE. Split the running set into aged / idle / unobservable. */
export function classifyStalls(
  runs: StallCandidate[],
  now: number,
  opts: { agedHours: number; idleMinutes: number }
): StallReport {
  const aged: StalledRun[] = [];
  const idle: StalledRun[] = [];
  let unobservable = 0;

  for (const run of runs) {
    const ageHours = (now - run.startedAt.getTime()) / (60 * MINUTE_MS);
    const idleMinutes =
      run.lastActivityAt === null
        ? null
        : (now - run.lastActivityAt.getTime()) / MINUTE_MS;
    const verdict = classifyRunStall(run, now, opts);
    if (verdict === "aged") {
      aged.push({
        id: run.id,
        flowType: run.flowType,
        flowName: run.flowName,
        ageHours,
        idleMinutes,
        verdict,
      });
      continue;
    }
    if (verdict === "idle") {
      idle.push({
        id: run.id,
        flowType: run.flowType,
        flowName: run.flowName,
        ageHours,
        idleMinutes,
        verdict,
      });
      continue;
    }
    // Not aged, not idle. If we could not have SEEN idleness, say so.
    if (run.lastActivityAt === null) unobservable += 1;
  }

  aged.sort((a, b) => b.ageHours - a.ageHours);
  idle.sort((a, b) => (b.idleMinutes ?? 0) - (a.idleMinutes ?? 0));
  return { aged, idle, unobservable };
}
