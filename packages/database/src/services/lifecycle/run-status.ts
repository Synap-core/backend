/**
 * THE RUN STATUS WRITE — the one writer of `playbook_runs.status` once a run
 * exists, on the model of `setSessionStatus`. Every door that moves a run (the
 * capture applier, the approval replay, the close door, unfollow, revive,
 * reopen, the generate decision, the approved start, cancel, redispatch, the
 * reaper's sweeps) calls this; a run is BORN with its first status (`queued`,
 * or `running` when its holder works it from birth), which is not a move. A
 * holder's claim moves it `running` through {@link claimRun}.
 *
 * One transaction (the caller's, as a savepoint, or its own):
 *   1. lock the rows that match (`runId` and/or `where`) AND stand in `from`
 *      — the compare-and-set: a row that moved meanwhile is not matched, so it
 *      is left as it is (a finished run's verdict is never overwritten by a
 *      door that names only live statuses in `from`);
 *   2. ONE UPDATE writes `status = to` and the caller's other columns (`set`,
 *      e.g. `stopReason`, `completedAt`, `summary`) on exactly those rows;
 *   3. each row whose status actually changed owes its transition
 *      (`playbook_run.transition.completed`, categories from
 *      `RUN_STATUS_DECLARATION`) through the outbox. A bulk sweep owes one
 *      transition per row.
 *
 * NOT here, by design: settling the parent automation run. That helper lives
 * in @synap/jobs (`settleParentAutomationRunFromChild`), which this package
 * cannot import; every caller that can reach a terminal status calls it after
 * this returns (tripwire `playbook-run-terminal-settles-parent`). A run into a
 * PAUSED status (`waiting_on_you`, `stale`, `proposed`) records a hold like
 * any pause: an agent's capture that gives none gets `defaultHold`, the way
 * the session reaper's pause does, never a refusal.
 *
 * Not dispatched inline (a caller's transaction may still be open): the
 * sweeper delivers within a minute or two.
 */
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  RUN_STATUS_DECLARATION,
  runStatusesIn,
  type RunHolder,
  type RunHolderKind,
} from "@synap-core/types/units";
import {
  decideMoveHold,
  type Hold,
  type RecordedHold,
  type RunTransitionPayload,
  type TransitionCause,
} from "@synap-core/types/lifecycle";
import { PLANNED_SESSION_STATUS } from "@synap-core/types/focus-sessions";
import type * as schema from "../../schema/index.js";
import {
  playbookRuns,
  type PlaybookRun,
  type PlaybookRunStatus,
} from "../../schema/playbook-runs.js";
import { focusSessions } from "../../schema/focus-sessions.js";
import { insertTransitionOutbox } from "./transition-outbox.js";
import { HoldRefusedError, listHolds } from "./holds.js";
import {
  transitionBaseOf,
  type WorkUnitActor,
} from "./work-unit-transition.js";

type Db = PostgresJsDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** A run row's other columns, as an UPDATE sets them (values or SQL). */
export type RunColumnsPatch = Omit<
  PgUpdateSetSource<typeof playbookRuns>,
  "status" | "id"
>;

/**
 * The hold a run's pause records when its mover gives none: the run waits on
 * the person (its session owes them), reviewed on the run cadence.
 */
export const RUN_PAUSE_DEFAULT_HOLD: Hold = {
  on: "person",
  reason: "The run waits on its session's person.",
};

export interface SetRunStatusInput {
  /** The run to move. */
  runId?: string;
  /**
   * A set-based predicate (the reaper's sweeps), ANDed with `runId` when both
   * are given. One of the two is required.
   */
  where?: SQL;
  /** The compare-and-set: only rows standing in one of these move. */
  from: PlaybookRunStatus | readonly PlaybookRunStatus[];
  to: PlaybookRunStatus;
  /** `userId` defaults to each run's owner (its session's, else its creator). */
  actor: WorkUnitActor;
  reason?: string | null;
  proposalId?: string | null;
  /** The other columns written in the SAME statement (never the status). */
  set?: RunColumnsPatch;
  /** What a move into a paused status waits on, given by the mover. */
  hold?: Hold | null;
  /**
   * The hold a pause records when none is given — for an agent too: a run's
   * pause is reported by its executor (the capture, the reaper), never chosen
   * as a pause with a reason, so it is never refused. Default
   * {@link RUN_PAUSE_DEFAULT_HOLD}.
   */
  defaultHold?: Hold;
  occurredAt?: Date | null;
  appId?: string | null;
  /** The move that caused this one (a reaction). */
  cause?: TransitionCause | null;
}

export interface SetRunStatusResult {
  /** Every row written (a row already at `to` is written, owes nothing). */
  rows: PlaybookRun[];
  /** One per row whose status changed, owed in the same transaction. */
  transitions: RunTransitionPayload[];
}

export async function setRunStatus(
  db: Db | Tx,
  input: SetRunStatusInput
): Promise<SetRunStatusResult> {
  if (!input.runId && !input.where) {
    throw new Error("setRunStatus needs a runId or a where");
  }
  const from: PlaybookRunStatus[] =
    typeof input.from === "string" ? [input.from] : [...input.from];
  // `db.transaction` opens one; a caller's `tx.transaction` a savepoint.
  return (db as Db).transaction(async (tx) => {
    const locked = await tx
      .select({
        id: playbookRuns.id,
        status: playbookRuns.status,
        sessionId: playbookRuns.sessionId,
        createdBy: playbookRuns.createdBy,
      })
      .from(playbookRuns)
      .where(
        and(
          input.runId ? eq(playbookRuns.id, input.runId) : undefined,
          input.where,
          inArray(playbookRuns.status, from)
        )
      )
      // One lock order for every writer, so two bulk moves cannot deadlock.
      .orderBy(asc(playbookRuns.id))
      .for("update", { of: playbookRuns });
    if (locked.length === 0) return { rows: [], transitions: [] };

    // Each run's place: its session's owner, project and goal.
    const sessionIds = [
      ...new Set(
        locked.map((r) => r.sessionId).filter((v): v is string => !!v)
      ),
    ];
    const sessions = new Map(
      (sessionIds.length
        ? await tx
            .select({
              id: focusSessions.id,
              userId: focusSessions.userId,
              projectId: focusSessions.projectId,
              trackId: focusSessions.trackId,
            })
            .from(focusSessions)
            .where(inArray(focusSessions.id, sessionIds))
        : []
      ).map((s) => [s.id, s])
    );

    // The hold each row's move records — decided BEFORE the write. Rows
    // already paused carry their own.
    const toCategory = RUN_STATUS_DECLARATION[input.to].category;
    const since = input.occurredAt ?? new Date();
    const carried = new Map<string, RecordedHold>();
    if (toCategory === "paused") {
      const paused = locked.filter(
        (r) => RUN_STATUS_DECLARATION[r.status].category === "paused"
      );
      for (const h of await listHolds(tx, {
        subjects: paused.map((r) => ({
          subjectType: "playbook_run" as const,
          subjectId: r.id,
        })),
      })) {
        carried.set(h.subjectId, h.hold);
      }
    }
    const holds = new Map<string, RecordedHold | null>();
    for (const r of locked) {
      if (r.status === input.to) continue;
      const decided = decideMoveHold({
        from: r.status,
        fromCategory: RUN_STATUS_DECLARATION[r.status].category,
        toCategory,
        actorKind: input.actor.kind,
        // A run's pause is REPORTED by its executor, never chosen: an agent's
        // capture into a paused status records the default hold instead of
        // being refused (`approved` is the flag `decideMoveHold` reads to
        // record rather than refuse).
        approved:
          Boolean(input.proposalId) ||
          (input.actor.kind === "agent" && !input.hold),
        given: input.hold,
        current: carried.get(r.id) ?? null,
        fallback: input.defaultHold ?? RUN_PAUSE_DEFAULT_HOLD,
        since,
        base: "run",
      });
      if (!decided.ok) throw new HoldRefusedError(decided);
      holds.set(r.id, decided.hold);
    }

    const rows = await tx
      .update(playbookRuns)
      .set({ ...input.set, status: input.to })
      .where(
        inArray(
          playbookRuns.id,
          locked.map((r) => r.id)
        )
      )
      .returning();

    const prior = new Map(locked.map((r) => [r.id, r]));
    const transitions = rows
      .filter((row) => prior.get(row.id)!.status !== input.to)
      .map((row): RunTransitionPayload => {
        const was = prior.get(row.id)!;
        const session = row.sessionId ? sessions.get(row.sessionId) : undefined;
        return {
          ...transitionBaseOf({
            subjectId: row.id,
            from: was.status,
            to: input.to,
            fromCategory: RUN_STATUS_DECLARATION[was.status].category,
            category: RUN_STATUS_DECLARATION[input.to].category,
            actor: input.actor,
            ownerUserId: session?.userId ?? row.createdBy,
            // The run's session is its context: the event lands in its history.
            sessionId: row.sessionId ?? null,
            reason: input.reason,
            proposalId: input.proposalId,
            workspaceId: row.workspaceId ?? null,
            occurredAt: input.occurredAt,
            hold: holds.get(row.id) ?? null,
            appId: input.appId,
            cause: input.cause,
          }),
          subjectType: "playbook_run",
          playbookId: row.playbookId,
          projectId: session?.projectId ?? null,
          trackId: session?.trackId ?? null,
          stopReason: row.stopReason ?? null,
        };
      });
    await insertTransitionOutbox(tx, transitions);
    return { rows, transitions };
  });
}

/** A holder named now; `claimed` when it works the run from this moment. */
export function runHolder(
  kind: RunHolderKind,
  id: string | null,
  claimed = false
): RunHolder {
  const now = new Date().toISOString();
  return { kind, id, assignedAt: now, claimedAt: claimed ? now : null };
}

/**
 * The status a run is born in beside its session (founder P4, 21 Nov 2026):
 * a PLANNED step's run waits (`queued`, its holder already named and
 * claimed) and starts with its step — `setSessionStatus` moves it to
 * `running` when the step leaves `forming`. Any other session's run runs.
 */
export function runBirthStatus(
  sessionStatus: string | null | undefined
): "queued" | "running" {
  return sessionStatus === PLANNED_SESSION_STATUS && false ? "queued" : "running";
}

/**
 * SQL over `playbook_runs`: the run's holder has CLAIMED it (a starter's run
 * is claimed from birth). A planned step's own run is one; a run handed to
 * another agent is not, and keeps waiting for that agent's claim.
 */
export const RUN_HOLDER_CLAIMED_SQL = sql`(${playbookRuns.holder} ->> 'claimedAt') IS NOT NULL`;

/** The run's starter holds it, working it from birth: its agent, else the person. */
export function starterHolder(
  userId: string,
  agentUserId: string | null | undefined
): RunHolder {
  return agentUserId
    ? runHolder("agent", agentUserId, true)
    : runHolder("person", userId, true);
}

/**
 * The run's `holder` once claimed, as an UPDATE writes it: the kind and id
 * given fill what the row's holder left open, and a claim already stamped
 * keeps its time.
 */
export function claimedHolderSql(holder: {
  kind?: RunHolderKind | null;
  id?: string | null;
}): SQL {
  const now = new Date().toISOString();
  return sql`jsonb_build_object(
    'kind', coalesce(${holder.kind ?? null}::text, ${playbookRuns.holder} ->> 'kind', 'none'),
    'id', coalesce(${holder.id ?? null}::text, ${playbookRuns.holder} ->> 'id'),
    'assignedAt', coalesce(${playbookRuns.holder} ->> 'assignedAt', ${now}::text),
    'claimedAt', coalesce(${playbookRuns.holder} ->> 'claimedAt', ${now}::text)
  )`;
}

/**
 * THE claim: the run's holder took it, so the run is `running`. Moves a run
 * still waiting for a claim (`queued`, or `blocked` past its window) and
 * stamps `holder.claimedAt`. A run already claimed, or ended, is left as it
 * is: empty `rows`.
 */
export async function claimRun(
  db: Db | Tx,
  input: {
    runId?: string;
    where?: SQL;
    holder: { kind: RunHolderKind; id: string | null };
    reason: string;
  }
): Promise<SetRunStatusResult> {
  return setRunStatus(db, {
    runId: input.runId,
    where: input.where,
    from: [...runStatusesIn(["open"]), "blocked"],
    to: "running",
    actor: { kind: "system" },
    reason: input.reason,
    set: { holder: claimedHolderSql(input.holder) },
  });
}

/**
 * An agent's acknowledgment of the work handed to it — its first write
 * attributed to the session, or its wait on the session's answers: the run
 * of that session handed to THAT agent is claimed. A run handed to an agent
 * not named yet is the executor's to claim, once it routed one.
 */
export async function claimRunAsAgent(
  db: Db | Tx,
  sessionId: string,
  agentUserId: string
): Promise<SetRunStatusResult> {
  return claimRun(db, {
    where: and(
      eq(playbookRuns.sessionId, sessionId),
      sql`${playbookRuns.holder} ->> 'kind' = 'agent'`,
      sql`${playbookRuns.holder} ->> 'id' = ${agentUserId}`
    ),
    holder: { kind: "agent", id: agentUserId },
    reason: "Its agent picked the work up.",
  });
}
