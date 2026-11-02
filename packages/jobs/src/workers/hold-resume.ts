/**
 * HOLD RESUME (status-flow plan W4) — a paused thing goes back to the status
 * it left when what it waited on is over:
 *
 *   - `until.date`: the hourly sweep (this queue with no data) resumes every
 *     current hold whose date has come;
 *   - `until.moves`: the reactor below sends this queue the transition of
 *     every move; the job resumes the holds that waited on that thing (and,
 *     with `until.to`, on it reaching that status or category);
 *   - `until.moves` naming a DEV FACT (`pr:<owner/name>#<n>`,
 *     `main:<owner/name>`, `job:<name>`, plan P1.4): the observation door
 *     (api `record-observation.ts`) sends this queue `devFact` = that ref
 *     when a fact that may be it is recorded, and the hourly sweep re-checks
 *     every dev hold (a fact recorded while the queue was down, or before
 *     the pause). Either way the ONE rule decides (`holdDevRefMet`,
 *     `@synap-core/types`) over the facts the hold's owner recorded.
 *
 * A passed `reviewBy` is NOT a move: it is a signal the watcher reads
 * (`CurrentHold.reviewDue`). The holds are read with the one helper
 * (`listHolds`, @synap/database); each resume is the SYSTEM's move through
 * the subject's own write — `applyStatusMove` for an entity, the goal's
 * `TrackRepository.transitionStatus`, `setSessionStatus` for a session — a
 * compare-and-set from the paused status, so a thing someone moved meanwhile
 * is left as it is. The resume executes a decision already made (the pause
 * and its `until` went through governance when they were filed), so it is
 * not governed again, like an approval replay.
 */
import {
  EventRepository,
  TrackRepository,
  and,
  applyStatusMove,
  db,
  desc,
  drizzleSql,
  eq,
  events,
  gt,
  inArray,
  listHolds,
  resolveStatusMoveTarget,
  setSessionStatus,
  sql,
  type CurrentHold,
} from "@synap/database";
import {
  dispatchLifecycleTransition,
  emitSideEffects,
  registerReactor,
  type Reactor,
} from "@synap/events";
import { createLogger } from "@synap-core/core";
import { CHECK_GATE_METADATA_KEY } from "@synap-core/types/focus-sessions";
import type { SessionStatus } from "@synap-core/types/focus-sessions";
import {
  holdWokenBy,
  parseHoldDevRef,
  type HoldDevRef,
} from "@synap-core/types/lifecycle";
import {
  DEV_LOOP_EVENT_TYPES,
  devboxJobWorkflow,
  holdDevRefMet,
  type DevLoopEventRowLike,
} from "@synap-core/types";
import type { ProjectTrackStatus } from "@synap/database/schema";

const logger = createLogger({ module: "hold-resume" });

export const HOLD_RESUME_QUEUE = "hold-resume";
/** Hourly: a hold whose date has come resumes within the hour. */
export const HOLD_RESUME_CRON = "23 * * * *";

/**
 * What moved, when the job was sent by the reactor, or the dev fact that may
 * have landed, when the observation door sent it (both absent: the hourly
 * sweep).
 */
export interface HoldResumeJobData {
  awaiting?: {
    subjectType: string;
    subjectId: string;
    to: string;
    category: string;
  };
  /** A dev ref in its stored spelling (`holdDevMovesRef`): `pr:owner/name#12`. */
  devFact?: string;
}

/**
 * The facts the dev holds are decided on — ONE query per kind of ref, for
 * every hold at once (never one per hold: the hourly sweep re-checks every
 * dev hold). Each hold then reads its own rows: its owner's, of its ref,
 * after its pause began where the ref is decided by the newest fact (a main,
 * a job). Returned per hold, in `held` order.
 *
 * Deliberately the OWNER floor (`events.userId = h.userId`), not the shared
 * `eventVisibleWhere` the PR fold reads with: a read shows a fact, a hold
 * ACTS on it (moves a status). Under the shared floor any workspace member's
 * key (an agent's included) could record a forged `dev.pr_merged` and resume
 * someone else's hold. The producers post under the owner's key, so the owner
 * floor loses no real fact. (`eventVisibleWhere` also lives in `@synap/api`,
 * which depends on this package.)
 *
 * Bounded: a PR's facts are the few its number names; a main's and a job's
 * are the NEWEST one per owner and repo (job) since the earliest pause that
 * waits on it — what the per-hold `limit 1` read before.
 */
async function readDevFactRows(
  holds: ReadonlyArray<{ ref: HoldDevRef; h: CurrentHold }>
): Promise<DevLoopEventRowLike[][]> {
  const select = {
    userId: events.userId,
    type: events.type,
    timestamp: events.timestamp,
    data: events.data,
  };
  const repoOf = drizzleSql`lower(${events.data}->>'repo')`;
  const prs = holds.flatMap(({ ref, h }) =>
    ref.kind === "pr"
      ? [{ user: h.userId, repo: ref.repo.toLowerCase(), number: ref.number }]
      : []
  );
  const mains = holds.flatMap(({ ref, h }) =>
    ref.kind === "main"
      ? [{ user: h.userId, repo: ref.repo.toLowerCase(), since: h.hold.since }]
      : []
  );
  const jobs = holds.flatMap(({ ref, h }) =>
    ref.kind === "job"
      ? [
          {
            user: h.userId,
            workflow: devboxJobWorkflow(ref.name),
            since: h.hold.since,
          },
        ]
      : []
  );
  const earliest = (xs: ReadonlyArray<{ since: string }>) =>
    new Date(Math.min(...xs.map((x) => Date.parse(x.since))));
  const tuples = (rows: ReadonlyArray<ReadonlyArray<string>>) =>
    drizzleSql.join(
      rows.map(
        (r) =>
          drizzleSql`(${drizzleSql.join(
            r.map((v) => drizzleSql`${v}::text`),
            drizzleSql`, `
          )})`
      ),
      drizzleSql`, `
    );
  type Row = DevLoopEventRowLike & { userId: string };
  const [prRows, mainRows, jobRows] = await Promise.all([
    prs.length
      ? db
          .select(select)
          .from(events)
          .where(
            and(
              inArray(events.type, [
                DEV_LOOP_EVENT_TYPES.prOpened,
                DEV_LOOP_EVENT_TYPES.prMerged,
                DEV_LOOP_EVENT_TYPES.prClosed,
              ]),
              drizzleSql`(${events.userId}, ${repoOf}, ${events.data}->>'number') in (${tuples(
                prs.map((p) => [p.user, p.repo, String(p.number)])
              )})`
            )
          )
      : Promise.resolve([] as Row[]),
    mains.length
      ? db
          .selectDistinctOn([events.userId, repoOf], select)
          .from(events)
          .where(
            and(
              eq(events.type, DEV_LOOP_EVENT_TYPES.repoSnapshot),
              drizzleSql`(${events.userId}, ${repoOf}) in (${tuples(
                mains.map((m) => [m.user, m.repo])
              )})`,
              gt(events.timestamp, earliest(mains))
            )
          )
          .orderBy(events.userId, repoOf, desc(events.timestamp))
      : Promise.resolve([] as Row[]),
    jobs.length
      ? db
          .selectDistinctOn(
            [events.userId, drizzleSql`${events.data}->>'workflow'`],
            select
          )
          .from(events)
          .where(
            and(
              eq(events.type, DEV_LOOP_EVENT_TYPES.ciFinished),
              drizzleSql`(${events.userId}, ${events.data}->>'workflow') in (${tuples(
                jobs.map((j) => [j.user, j.workflow])
              )})`,
              gt(events.timestamp, earliest(jobs))
            )
          )
          .orderBy(
            events.userId,
            drizzleSql`${events.data}->>'workflow'`,
            desc(events.timestamp)
          )
      : Promise.resolve([] as Row[]),
  ]);
  const data = (r: Row) => (r.data ?? {}) as Record<string, unknown>;
  const after = (r: Row, since: string) =>
    new Date(r.timestamp).getTime() > Date.parse(since);
  return holds.map(({ ref, h }) => {
    const mine = (r: Row) => r.userId === h.userId;
    switch (ref.kind) {
      case "pr": {
        const repo = ref.repo.toLowerCase();
        return (prRows as Row[]).filter(
          (r) =>
            mine(r) &&
            String(data(r).repo ?? "").toLowerCase() === repo &&
            data(r).number === ref.number
        );
      }
      case "main": {
        const repo = ref.repo.toLowerCase();
        return (mainRows as Row[]).filter(
          (r) =>
            mine(r) &&
            String(data(r).repo ?? "").toLowerCase() === repo &&
            after(r, h.hold.since)
        );
      }
      case "job": {
        const workflow = devboxJobWorkflow(ref.name);
        return (jobRows as Row[]).filter(
          (r) =>
            mine(r) && data(r).workflow === workflow && after(r, h.hold.since)
        );
      }
    }
  });
}

/** The dev holds whose fact is in, with the ref each waited on. */
async function devHoldsMet(
  held: readonly CurrentHold[]
): Promise<Array<{ h: CurrentHold; moves: string }>> {
  const dev = held.flatMap((h) => {
    const until = h.hold.until;
    if (!until || !("moves" in until)) return [];
    const ref = parseHoldDevRef(until.moves);
    return ref ? [{ h, ref, until, moves: until.moves }] : [];
  });
  if (dev.length === 0) return [];
  const rows = await readDevFactRows(dev);
  return dev.flatMap(({ h, ref, until, moves }, i) =>
    holdDevRefMet(ref, until, h.hold.since, rows[i]!) ? [{ h, moves }] : []
  );
}

export async function handleHoldResume(
  data: HoldResumeJobData = {},
  now: Date = new Date()
): Promise<{ resumed: number; skipped: number }> {
  const moved = data.awaiting;
  const devFact = data.devFact ? parseHoldDevRef(data.devFact) : null;
  let held: Array<{ h: CurrentHold; reason: string }>;
  if (moved) {
    held = (await listHolds(db, { awaiting: moved }, now))
      .filter((h) => holdWokenBy(h.hold.until, moved))
      .map((h) => ({
        h,
        reason: `What it waited on (${moved.subjectType}:${moved.subjectId}) moved to ${moved.to}.`,
      }));
  } else if (data.devFact) {
    const i = data.devFact.indexOf(":");
    held = devFact
      ? (
          await devHoldsMet(
            await listHolds(
              db,
              {
                awaiting: {
                  subjectType: data.devFact.slice(0, i),
                  subjectId: data.devFact.slice(i + 1),
                },
              },
              now
            )
          )
        ).map(({ h, moves }) => ({ h, reason: devFactReason(moves) }))
      : [];
  } else {
    const [dated, dev] = await Promise.allSettled([
      listHolds(db, { resumeDueBy: now }, now),
      listHolds(db, { awaitingDevFacts: true }, now).then(devHoldsMet),
    ]);
    // The date holds never wait on the dev half: a failed dev-fact read is
    // logged and retried on the next tick, and the due dates still resume.
    if (dev.status === "rejected") {
      logger.warn(
        { err: dev.reason },
        "dev-fact hold read failed — retried on the next tick"
      );
    }
    if (dated.status === "rejected") throw dated.reason;
    held = [
      ...dated.value.map((h) => ({
        h,
        reason: `Its hold ran until ${(h.hold.until as { date: string }).date}.`,
      })),
      ...(dev.status === "fulfilled" ? dev.value : []).map(({ h, moves }) => ({
        h,
        reason: devFactReason(moves),
      })),
    ];
  }
  const woken = Boolean(moved || data.devFact);
  let resumed = 0;
  let failure: unknown = null;
  for (const { h, reason } of held) {
    try {
      if (await resumeHold(h, reason)) resumed++;
    } catch (err) {
      failure = err;
      logger.warn(
        { err, subjectType: h.subjectType, subjectId: h.subjectId },
        woken
          ? "hold resume failed — the job is retried"
          : "hold resume failed — retried on the next tick"
      );
    }
  }
  // A move happens once: a failed wake is retried by pg-boss (what already
  // resumed is no longer held, so a retry never moves it twice). The hourly
  // sweep needs no retry: the next tick finds the hold still due.
  if (woken && failure) throw failure;
  if (held.length > 0) {
    logger.info(
      {
        resumed,
        skipped: held.length - resumed,
        by: moved ? "move" : data.devFact ? "dev_fact" : "sweep",
      },
      "Resumed held things"
    );
  }
  return { resumed, skipped: held.length - resumed };
}

function devFactReason(moves: string): string {
  return `What it waited on (${moves}) is in.`;
}

/** Move one held thing back to the status its pause began from; false when it did not move. */
async function resumeHold(h: CurrentHold, reason: string): Promise<boolean> {
  const to = h.hold.resumeTo;
  // A pause recorded before anyone knew where it came from has nowhere to go.
  if (!to) return false;
  switch (h.subjectType) {
    case "entity": {
      const resolved = await resolveStatusMoveTarget(db, {
        entityId: h.subjectId,
        facetId: h.facetId,
        workspaceId: h.workspaceId,
      });
      if (!resolved.ok) return false;
      const result = await applyStatusMove(db, {
        target: resolved.target,
        expectedFrom: h.status,
        to,
        actor: { kind: "system", userId: h.userId },
        strict: true,
        reason,
        lensWorkspaceId: h.workspaceId,
      });
      if (result.status !== "moved") return false;
      await dispatchLifecycleTransition(result.transition.transitionId);
      return true;
    }
    case "track": {
      const row = await new TrackRepository(
        db,
        new EventRepository(sql)
      ).transitionStatus(
        h.subjectId,
        {
          from: h.status as ProjectTrackStatus,
          to: to as ProjectTrackStatus,
          // A resumed goal is held by nothing (as `applyTrackStatus`).
          dropMetadataKey: CHECK_GATE_METADATA_KEY,
          actor: { kind: "system" },
          reason,
        },
        h.userId
      );
      if (!row) return false;
      await followUp(h, to);
      // The goal loop reads a goal's status moves off this event.
      void emitSideEffects({
        subjectType: "track",
        action: "update",
        subjectId: row.id,
        userId: h.userId,
        workspaceId: h.workspaceId,
        data: {
          trackId: row.id,
          projectId: row.projectId,
          fromStatus: h.status,
          toStatus: to,
        },
      }).catch((err) =>
        logger.warn({ err, trackId: row.id }, "track.update emit failed")
      );
      return true;
    }
    case "focus_session": {
      const { rows, transitions } = await setSessionStatus(db, {
        sessionId: h.subjectId,
        from: h.status as SessionStatus,
        to: to as SessionStatus,
        actor: { kind: "system" },
        reason,
        // Resuming is activity: the idle clock starts again.
        set: { updatedAt: new Date() },
      });
      for (const t of transitions) {
        await dispatchLifecycleTransition(t.transitionId);
      }
      if (rows.length > 0) await followUp(h, to);
      return rows.length > 0;
    }
  }
}

/**
 * What the api's own doors do after the same move (a goal's judgement
 * notices, `refreshGoalJudgements`; a stale session's runs back to running,
 * as `reviveStaleSession`). `@synap/api` depends on `@synap/jobs`, so it fills
 * this slot at boot (apps/api), the pattern of `registerSessionCloser`.
 */
export type HoldResumeFollowUp = (resumed: {
  subjectType: CurrentHold["subjectType"];
  subjectId: string;
  userId: string;
  from: string;
  to: string;
}) => Promise<void>;

let holdResumeFollowUp: HoldResumeFollowUp | null = null;

export function registerHoldResumeFollowUp(fn: HoldResumeFollowUp): void {
  holdResumeFollowUp = fn;
}

async function followUp(h: CurrentHold, to: string): Promise<void> {
  if (!holdResumeFollowUp) {
    logger.warn(
      { subjectType: h.subjectType, subjectId: h.subjectId },
      "hold resume follow-up not registered — apps/api must call registerHoldResumeFollowUp() at boot"
    );
    return;
  }
  await holdResumeFollowUp({
    subjectType: h.subjectType,
    subjectId: h.subjectId,
    userId: h.userId,
    from: h.status,
    to,
  });
}

/**
 * Every transition is a move a hold may be waiting on: sent to the queue
 * (off the emit path), where the job reads the holds that wait on it.
 */
export const holdResumeReactor: Reactor = {
  id: "hold-resume",
  match: (payload) => payload.action === "transition",
  async handler(payload, { boss }) {
    const d = payload.data ?? {};
    if (typeof d.to !== "string" || typeof d.category !== "string") return;
    await boss.send(
      HOLD_RESUME_QUEUE,
      {
        awaiting: {
          subjectType: payload.subjectType,
          subjectId: payload.subjectId,
          to: d.to,
          category: d.category,
        },
      } satisfies HoldResumeJobData,
      // A redelivered transition is one wake, not two.
      payload.eventId ? { singletonKey: `hold-resume:${payload.eventId}` } : {}
    );
  },
};

let registered = false;

/** Register the reactor; called once where the workers register. */
export function registerHoldResumeReactor(): void {
  if (registered) return;
  registered = true;
  registerReactor(holdResumeReactor);
}
