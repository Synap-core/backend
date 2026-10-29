/**
 * THE SESSION STATUS WRITE (status-flow plan W2) — the one writer of
 * `focus_sessions.status` once a session exists. Every door that moves a
 * session (the reapers, revive, the stage gates, the check gate, process-sync,
 * the update doors, the close door) calls this; a session is BORN with its
 * first status (create, spawn, schedule), which is not a move.
 *
 * One transaction:
 *   1. lock the rows that match (`sessionId` and/or `where`) AND stand in
 *      `from` — the compare-and-set: a row that moved meanwhile is not
 *      matched, so it is left as it is;
 *   2. ONE UPDATE writes `status = to` and the caller's other columns (`set`)
 *      on exactly those rows;
 *   3. each row whose status actually changed owes its transition
 *      (`focus_session.transition.completed`, the one transition shape,
 *      categories from `SESSION_STATUS_DECLARATION`) through the outbox.
 *
 * Nothing else is decided here: who may move a session, and which statuses a
 * door accepts, stay with the door (the close door stays the only one that
 * writes a terminal status). `updatedAt` is the caller's column like any
 * other: the reapers leave it alone (it is the last-real-activity signal),
 * the doors that ARE activity pass it in `set`.
 *
 * The transitions are not dispatched inline (a caller's own transaction may
 * still be open): the sweeper delivers them within a minute or two.
 */
import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  SESSION_STATUSES,
  SESSION_STATUS_DECLARATION,
  type SessionStatus,
} from "@synap-core/types/focus-sessions";
import {
  HOLD_NOT_A_PAUSE_MESSAGE,
  decideMoveHold,
  type Hold,
  type RecordedHold,
  type WorkUnitTransitionPayload,
} from "@synap-core/types/lifecycle";
import type * as schema from "../../schema/index.js";
import {
  focusSessions,
  type FocusSession,
} from "../../schema/focus-sessions.js";
import { insertTransitionOutbox } from "./transition-outbox.js";
import { HoldRefusedError, listHolds } from "./holds.js";
import {
  buildWorkUnitTransition,
  type WorkUnitActor,
} from "./work-unit-transition.js";

type Db = PostgresJsDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** A session row's other columns, as an UPDATE sets them (values or SQL). */
type SessionColumnsPatch = Omit<
  PgUpdateSetSource<typeof focusSessions>,
  "status"
>;

export interface SetSessionStatusInput {
  /** The session to move. */
  sessionId?: string;
  /**
   * A set-based predicate (the reapers' sweeps), ANDed with `sessionId` when
   * both are given. One of the two is required.
   */
  where?: SQL;
  /** The compare-and-set: only rows standing in one of these move. */
  from: SessionStatus | readonly SessionStatus[];
  to: SessionStatus;
  /** `userId` defaults to each session's owner (a reaper's bulk move). */
  actor: WorkUnitActor;
  reason?: string | null;
  proposalId?: string | null;
  /** The other columns written in the SAME statement (never the status). */
  set?: SessionColumnsPatch;
  /**
   * What a move into a paused status (`paused`, `stale`) waits on, given by
   * the mover. Absent: refused for an agent (`HoldRefusedError`), else
   * `defaultHold` (`unspecified` when none). A session already paused keeps
   * the hold it had (the reaper's `paused → stale`).
   */
  hold?: Hold | null;
  /** A person's or the system's hold when none is given (the reaper: nobody). */
  defaultHold?: Hold;
  /** When it really happened (already bounded by the door); default now. */
  occurredAt?: Date | null;
}

export interface SetSessionStatusResult {
  /** Every row written (a row already at `to` is written, owes nothing). */
  rows: FocusSession[];
  /** One per row whose status changed, owed in the same transaction. */
  transitions: WorkUnitTransitionPayload[];
}

export async function setSessionStatus(
  db: Db | Tx,
  input: SetSessionStatusInput
): Promise<SetSessionStatusResult> {
  if (!input.sessionId && !input.where) {
    throw new Error("setSessionStatus needs a sessionId or a where");
  }
  const from: SessionStatus[] =
    typeof input.from === "string" ? [input.from] : [...input.from];
  // `db.transaction` opens one; a caller's `tx.transaction` a savepoint — the
  // same call at runtime. Narrowed to one member because TS cannot call a
  // union of two generic signatures.
  return (db as Db).transaction(async (tx) => {
    const locked = await tx
      .select({ id: focusSessions.id, status: focusSessions.status })
      .from(focusSessions)
      .where(
        and(
          input.sessionId ? eq(focusSessions.id, input.sessionId) : undefined,
          input.where,
          inArray(focusSessions.status, from)
        )
      )
      // One lock order for every writer, so two bulk moves cannot deadlock.
      .orderBy(asc(focusSessions.id))
      .for("update", { of: focusSessions });
    if (locked.length === 0) return { rows: [], transitions: [] };

    // The hold each row's move records — decided BEFORE the write, so a
    // refused pause writes nothing. Rows already paused carry their own.
    const toCategory = SESSION_STATUS_DECLARATION[input.to].category;
    const since = input.occurredAt ?? new Date();
    const carried = new Map<string, RecordedHold>();
    if (toCategory === "paused") {
      const paused = locked.filter(
        (r) => SESSION_STATUS_DECLARATION[r.status].category === "paused"
      );
      for (const h of await listHolds(tx, {
        subjects: paused.map((r) => ({
          subjectType: "focus_session" as const,
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
        fromCategory: SESSION_STATUS_DECLARATION[r.status].category,
        toCategory,
        actorKind: input.actor.kind,
        approved: Boolean(input.proposalId),
        given: input.hold,
        current: carried.get(r.id) ?? null,
        fallback: input.defaultHold,
        since,
      });
      if (!decided.ok) throw new HoldRefusedError(decided);
      holds.set(r.id, decided.hold);
    }

    const rows = await tx
      .update(focusSessions)
      .set({ ...input.set, status: input.to })
      .where(
        inArray(
          focusSessions.id,
          locked.map((r) => r.id)
        )
      )
      .returning();

    const prior = new Map(locked.map((r) => [r.id, r.status]));
    const transitions = rows
      .filter((row) => prior.get(row.id) !== input.to)
      .map((row) => {
        const was = prior.get(row.id)!;
        return buildWorkUnitTransition({
          subjectType: "focus_session",
          subjectId: row.id,
          from: was,
          to: input.to,
          fromCategory: SESSION_STATUS_DECLARATION[was].category,
          category: SESSION_STATUS_DECLARATION[input.to].category,
          actor: input.actor,
          ownerUserId: row.userId,
          // The session is its own context: the event lands in its history.
          sessionId: row.id,
          reason: input.reason,
          proposalId: input.proposalId,
          workspaceId: row.workspaceId ?? null,
          projectId: row.projectId ?? null,
          trackId: row.trackId ?? null,
          occurredAt: input.occurredAt,
          hold: holds.get(row.id) ?? null,
        });
      });
    await insertTransitionOutbox(tx, transitions);
    return { rows, transitions };
  });
}

/**
 * A session row PATCH that may carry a status — the update doors (tRPC and
 * Hub REST PATCH, the MCP `update_session`, the `focus_session/update`
 * approval replay). With a status it is a move through
 * {@link setSessionStatus} from whatever the session stands at: the doors run
 * their own checks on the row they read first (a closed run stays closed; a
 * terminal status goes to the close door). Without one it is a plain write.
 * Returns the written rows (empty when the session is gone).
 */
export async function writeSessionPatch(
  db: Db | Tx,
  input: {
    sessionId: string;
    /** The row patch; a status in it is a value, never an expression. */
    set: SessionColumnsPatch & { status?: SessionStatus };
    actor: WorkUnitActor;
    proposalId?: string | null;
    /** With a pause: what it waits on (`setSessionStatus`). */
    hold?: Hold | null;
    occurredAt?: Date | null;
  }
): Promise<FocusSession[]> {
  const { status, ...rest } = input.set;
  if (status === undefined) {
    if (input.hold) {
      throw new HoldRefusedError({
        ok: false,
        code: "HOLD_NOT_A_PAUSE",
        message: HOLD_NOT_A_PAUSE_MESSAGE,
      });
    }
    return db
      .update(focusSessions)
      .set(rest)
      .where(eq(focusSessions.id, input.sessionId))
      .returning();
  }
  const { rows } = await setSessionStatus(db, {
    sessionId: input.sessionId,
    from: SESSION_STATUSES,
    to: status,
    actor: input.actor,
    proposalId: input.proposalId,
    set: rest,
    hold: input.hold,
    occurredAt: input.occurredAt,
  });
  return rows;
}
