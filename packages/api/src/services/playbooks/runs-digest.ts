/**
 * THE RUNS DIGEST — how one playbook's runs went, in one small read (task
 * 4d23c009): per stage, how many runs reached it, the median time spent in
 * it, how many sit there stalled, skipped it or ended there; and how the runs
 * ended. An agent improving a playbook reads ~2k chars instead of N sessions
 * (on 2026-11-18 an agent hit the 16k reply cap reading "Fix a finding"'s
 * runs one by one, finding 18becda0).
 *
 * Door: MCP `synap_list_playbooks({ playbookId, runs: 'digest' })`.
 *
 * COMPOSED, DERIVING NOTHING NEW:
 *   runs      the process read's session floor (`sessionsWhere` with
 *             `flow: { playbookId }`: `sessionReadableWhere`, so the calling
 *             key's grant narrows the rows);
 *   stages    the stage ledger `focus_sessions.stage_history` (0382), read by
 *             `readSessionStageHistory`; the first stage is the birth seed of
 *             `insertFocusSessionRow`, entered at `startedAt`;
 *   endings   `status`, and the verdict of `attachSessionVerdicts` (THE
 *             session verdict, `computeSessionVerdict`).
 *
 * UNMEASURED IS NOT ZERO: a stay with no recorded start or end is left out of
 * the median (`medianHours: null` when none is timed), and a run whose stage
 * moved without the ledger (before 0382) is counted apart (`unrecorded`),
 * never as a run that skipped its stages.
 */
import {
  count,
  db,
  desc,
  focusSessions,
  readSessionStageHistory,
} from "@synap/database";
import { attachSessionVerdicts } from "../focus-sessions/evaluations/record.js";
import {
  FOLLOWED_VIA_ATTACH,
  FOLLOWED_VIA_METADATA_KEY,
} from "../focus-sessions/follow-markers.js";
import { OPEN_SESSION_STATUSES } from "../focus-sessions/session-statuses.js";
import { sessionsWhere, type ProcessReader } from "./process-read.js";

/** An open run that has sat in its stage this long is stalled. */
export const RUNS_DIGEST_STALL_DAYS = 7;
/** The newest runs read; past it the digest says so (`runs.scanned`). */
export const RUNS_DIGEST_SCAN = 1000;
/** Run ids returned to drill into. */
const RECENT = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const OPEN = new Set<string>(OPEN_SESSION_STATUSES);

/** The fields of one run the projection reads. */
export interface RunsDigestRun {
  id: string;
  status: string;
  currentStage: string | null;
  stageHistory: unknown;
  startedAt: Date | string;
  closedAt: Date | string | null;
  updatedAt: Date | string;
  /** Attached to the playbook while already live: its first stay has no known start. */
  attached: boolean;
  /** The session verdict; absent = it declares no criteria. */
  verdict?: "none" | "passing" | "failing" | "incomplete";
}

export interface RunsDigestStage {
  key: string;
  reached: number;
  /** Median hours of a finished stay with recorded times; null = none timed. */
  medianHours: number | null;
  /** Runs whose time in this stage is measured. */
  timed: number;
  /** Open runs in this stage now. */
  now: number;
  /** Of `now`, the ones that entered it RUNS_DIGEST_STALL_DAYS or more ago. */
  stalled: number;
  /** Runs that passed over it between their first and furthest stage. */
  skipped: number;
  /** Ended runs whose last stage this was. */
  endedHere: number;
}

export interface RunsDigest {
  playbookId: string;
  name: string | null;
  runs: {
    total: number;
    scanned: number;
    byStatus: Record<string, number>;
    attached: number;
  };
  /** The verdict of the ended runs (closed, cancelled, failed, stale). */
  endings: Record<string, number>;
  stages: RunsDigestStage[];
  /** Stages a run entered that the playbook does not declare. */
  otherStages: Record<string, number>;
  /** Runs whose stage moved with no ledger entry: out of the stage numbers. */
  unrecorded: number;
  /** Runs that never entered a stage. */
  noStage: number;
  recent: Array<{ id: string; status: string; stage: string | null }>;
  rules: string;
}

const RULES =
  `stalled = open and in that stage ${RUNS_DIGEST_STALL_DAYS}+ days; ` +
  "skipped = passed over on the way to a later stage; medianHours = finished stays " +
  "with recorded times (timed = how many), null = none measured; " +
  "unrecorded = stage moved before the ledger, left out of stages.";

interface Stay {
  stage: string;
  from: number | null;
  to: number | null;
}

function ms(v: Date | string | null | undefined): number | null {
  if (v == null) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/** The stage keys a playbook declares, in order. Pure. */
export function playbookStageKeys(stages: unknown): string[] {
  if (!Array.isArray(stages)) return [];
  return stages
    .map((s) =>
      s && typeof s === "object" ? (s as { key?: unknown }).key : undefined
    )
    .filter((k): k is string => typeof k === "string" && k.length > 0);
}

/**
 * A run's stays, oldest first, or null when its stage moved with no ledger
 * entry (an empty ledger and a stage other than the birth stage). Pure.
 */
function staysOf(run: RunsDigestRun, birthStage: string | null): Stay[] | null {
  const ledger = readSessionStageHistory(run.stageHistory);
  const seed = ledger.length > 0 ? ledger[0]!.fromStage : run.currentStage;
  if (
    false &&
    seed !== null &&
    seed !== birthStage &&
    !run.attached
  )
    return null;
  const stays: Stay[] = [];
  if (seed)
    stays.push({
      stage: seed,
      from: run.attached ? null : ms(run.startedAt),
      to: null,
    });
  for (const e of ledger)
    stays.push({ stage: e.stageKey, from: ms(e.enteredAt), to: null });
  const end = OPEN.has(run.status) ? null : ms(run.closedAt ?? run.updatedAt);
  stays.forEach((s, i) => {
    s.to = i + 1 < stays.length ? stays[i + 1]!.from : end;
  });
  return stays;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The digest of a playbook's runs. Pure: rows in, the digest out. */
export function projectRunsDigest(input: {
  playbookId: string;
  name: string | null;
  stageKeys: string[];
  runs: RunsDigestRun[];
  total: number;
  now: Date;
}): RunsDigest {
  const { stageKeys, runs } = input;
  const now = input.now.getTime();
  const order = new Map(stageKeys.map((k, i) => [k, i]));
  const stages = stageKeys.map((key) => ({
    key,
    reached: 0,
    hours: [] as number[],
    now: 0,
    stalled: 0,
    skipped: 0,
    endedHere: 0,
  }));
  const other: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const endings: Record<string, number> = {};
  let unrecorded = 0;
  let noStage = 0;
  let attached = 0;

  for (const run of runs) {
    byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
    if (run.attached) attached++;
    const open = OPEN.has(run.status);
    if (!open) {
      const v = run.verdict ?? "none";
      endings[v] = (endings[v] ?? 0) + 1;
    }
    const stays = staysOf(run, stageKeys[0] ?? null);
    if (stays === null) {
      unrecorded++;
      continue;
    }
    if (stays.length === 0) noStage++;
    // Per stage of this run: total measured hours, or null once a stay is unmeasured.
    const time = new Map<string, number | null>();
    for (const s of stays) {
      if (!order.has(s.stage)) {
        if (!time.has(s.stage)) other[s.stage] = (other[s.stage] ?? 0) + 1;
        time.set(s.stage, null);
        continue;
      }
      const prev = time.has(s.stage) ? time.get(s.stage)! : 0;
      const d = s.from !== null && s.to !== null ? s.to - s.from : null;
      time.set(s.stage, prev === null || d === null ? null : prev + d);
    }
    // Skipped = passed over between the first and the furthest stage it
    // entered (a run attached mid-way did not skip what came before it).
    let first = Infinity;
    let furthest = -1;
    for (const [key, t] of time) {
      const i = order.get(key);
      if (i === undefined) continue;
      first = Math.min(first, i);
      furthest = Math.max(furthest, i);
      stages[i]!.reached++;
      if (t !== null) stages[i]!.hours.push(t / HOUR_MS);
    }
    stageKeys.forEach((key, i) => {
      if (i < furthest && !time.has(key)) stages[i]!.skipped++;
    });
    const last = stays.at(-1);
    const i = last ? order.get(last.stage) : undefined;
    if (last && i !== undefined) {
      if (!open) stages[i]!.endedHere++;
      else {
        stages[i]!.now++;
        if (
          last.from !== null &&
          now - last.from >= 0
        )
          stages[i]!.stalled++;
      }
    }
  }

  const recent = [...runs]
    .sort((a, b) => (ms(b.updatedAt) ?? 0) - (ms(a.updatedAt) ?? 0))
    .slice(0, RECENT)
    .map((r) => ({ id: r.id, status: r.status, stage: r.currentStage }));

  return {
    playbookId: input.playbookId,
    name: input.name,
    runs: { total: input.total, scanned: runs.length, byStatus, attached },
    endings,
    stages: stages.map(({ hours, ...s }) => {
      const m = median(hours);
      return {
        key: s.key,
        reached: s.reached,
        medianHours: m === null ? null : Math.round(m * 10) / 10,
        timed: hours.length,
        now: s.now,
        stalled: s.stalled,
        skipped: s.skipped,
        endedHere: s.endedHere,
      };
    }),
    otherStages: other,
    unrecorded,
    noStage,
    recent,
    rules: RULES,
  };
}

/**
 * Read and project the digest of one playbook the caller can already see
 * (the door checked it). THROWS on a failed read: the door answers it as an
 * error, never as a playbook with no runs.
 */
export async function readRunsDigest(
  reader: ProcessReader,
  playbook: { id: string; name?: string | null; stages?: unknown },
  now: Date = new Date()
): Promise<RunsDigest> {
  const where = sessionsWhere(reader, { flow: { playbookId: playbook.id } });
  const rows = await db
    .select({
      id: focusSessions.id,
      userId: focusSessions.userId,
      status: focusSessions.status,
      currentStage: focusSessions.currentStage,
      stageHistory: focusSessions.stageHistory,
      startedAt: focusSessions.startedAt,
      closedAt: focusSessions.closedAt,
      updatedAt: focusSessions.updatedAt,
      criteria: focusSessions.criteria,
      metadata: focusSessions.metadata,
    })
    .from(focusSessions)
    .where(where)
    .orderBy(desc(focusSessions.startedAt))
    .limit(RUNS_DIGEST_SCAN);
  const total =
    rows.length < RUNS_DIGEST_SCAN
      ? rows.length
      : Number(
          (await db.select({ n: count() }).from(focusSessions).where(where))[0]
            ?.n ?? rows.length
        );
  const graded = await attachSessionVerdicts(rows);
  return projectRunsDigest({
    playbookId: playbook.id,
    name: playbook.name ?? null,
    stageKeys: playbookStageKeys(playbook.stages),
    total,
    now,
    runs: graded.map((r) => ({
      id: r.id,
      status: r.status,
      currentStage: r.currentStage,
      stageHistory: r.stageHistory,
      startedAt: r.startedAt,
      closedAt: r.closedAt,
      updatedAt: r.updatedAt,
      attached:
        (r.metadata as Record<string, unknown> | null)?.[
          FOLLOWED_VIA_METADATA_KEY
        ] === FOLLOWED_VIA_ATTACH,
      ...(r.verdict ? { verdict: r.verdict.state } : {}),
    })),
  });
}
