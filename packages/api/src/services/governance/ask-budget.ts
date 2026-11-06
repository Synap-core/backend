/**
 * THE DAILY ASK BUDGET — the ONE place the day's asks are counted (D7,
 * founder-approved 2026-10-28). The pure rules (the unit of an ask, the rank,
 * the lanes) are `ask-budget-lanes.ts`; this file holds every read and write
 * of `daily_asks` (0367).
 *
 * THE COUNT. The first time an ask is headlined on a person's local day it is
 * STAMPED: a `daily_asks` row, until the person's `daily_ask_count` ceiling
 * (`governance_ceilings`, subject the person, default 5 —
 * `DEFAULT_DAILY_ASK_COUNT`) is reached. Two moments headline an ask:
 *   1. a needs-you read of the person's WHOLE pod (`signals.list` needs-you,
 *      `signals.count`, `signals.needsYou` with no narrowing lens) — the
 *      stamping read: it ranks the population and stamps into today's room;
 *   2. a push (`claimAskPush`) — a phone interruption IS a headline, so it
 *      takes a slot, or is not sent.
 * A NARROWED read (a space, a project, a session…) never stamps: it reads
 * today's stamps and draws an unstamped ask as Later once the day is full, as
 * Asks while room remains (where the next whole-pod read will most likely put
 * it). It cannot rank the person's whole day from a slice of it.
 *
 * THE DAY is the person's local day (`users.timezone`, UTC when unset or
 * unknown).
 *
 * PAST THE BUDGET nothing pushes and nothing is approved: this file never
 * writes a proposal, and Later is a lane, not a status.
 *
 * A FAILED READ is not an empty one. If the budget cannot be read (the ceiling,
 * the stamps, the timezone), every ask is drawn as Asks — the budget fails
 * OPEN, it never hides an ask — and the result says `status: "unmeasured"` so
 * no surface reads the numbers as a measurement. Logged, never swallowed.
 */

import {
  db,
  and,
  eq,
  inArray,
  dailyAsks,
  users,
  proposals,
  drizzleSql,
} from "@synap/database";
import { resolveCeiling } from "@synap/database/agent-governance";
import { createLogger } from "@synap-core/core";
import { resolveProposalWaits } from "../proposals/proposal-waits.js";
import {
  askUnitsOf,
  assignLanes,
  localDayOf,
  stampKey,
  type AskItemKind,
  type AskLane,
  type AskRowInput,
  type AskUnit,
} from "./ask-budget-lanes.js";

const logger = createLogger({ module: "ask-budget" });

export type { AskLane } from "./ask-budget-lanes.js";

/** What the budget said for one read. */
export type AskBudgetState =
  | {
      status: "measured";
      /** The person's `daily_ask_count`. */
      limit: number;
      /** Their local day, `YYYY-MM-DD`. */
      day: string;
      /** Asks headlined today so far (stamps), decided ones included. */
      used: number;
      /** Rows of this read in each lane. */
      asks: number;
      later: number;
    }
  | {
      /** The budget could not be read: every ask is drawn as Asks. */
      status: "unmeasured";
      asks: number;
      later: 0;
    };

/** The limit and the day — the two things every budget question needs. */
async function readBudgetFrame(
  userId: string,
  now: Date
): Promise<{ limit: number; day: string }> {
  const [ceiling, [user]] = await Promise.all([
    resolveCeiling({
      db,
      axis: "daily_ask_count",
      subject: { type: "user", id: userId },
    }),
    db
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  ]);
  return { limit: ceiling.value, day: localDayOf(now, user?.timezone) };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function readStamps(
  handle: typeof db | Tx,
  userId: string,
  day: string
): Promise<Set<string>> {
  const rows = await handle
    .select({ kind: dailyAsks.itemKind, id: dailyAsks.itemId })
    .from(dailyAsks)
    .where(and(eq(dailyAsks.userId, userId), eq(dailyAsks.day, day)));
  return new Set(rows.map((r) => stampKey(r.kind as AskItemKind, r.id)));
}

/** One stamp per person-day at a time: the read-rank-insert is serialised. */
async function lockDay(tx: Tx, userId: string, day: string) {
  await tx.execute(
    drizzleSql`select pg_advisory_xact_lock(hashtext(${`daily_asks:${userId}:${day}`}))`
  );
}

/** Do agents wait on these proposals? One batched read (`proposal-waits.ts`). */
async function proposalWaitsOf(
  userId: string,
  proposalIds: readonly string[]
): Promise<(id: string) => boolean> {
  if (proposalIds.length === 0) return () => false;
  const rows = await db
    .select({
      id: proposals.id,
      proposalType: proposals.proposalType,
      status: proposals.status,
      sessionId: proposals.sessionId,
      data: proposals.data,
    })
    .from(proposals)
    .where(inArray(proposals.id, [...new Set(proposalIds)]));
  const waits = await resolveProposalWaits(rows, { userId });
  return (id) => waits.get(id)?.waits === true;
}

/**
 * Give each ask row of a needs-you population its lane. `stamp` is true only
 * for a read of the person's WHOLE pod (see the file header). Rows that are
 * not asks are returned untouched (no `lane`).
 */
export async function assignAskLanes<T extends AskRowInput>(input: {
  userId: string;
  rows: readonly T[];
  stamp: boolean;
  now?: Date;
}): Promise<{ rows: Array<T & { lane?: AskLane }>; budget: AskBudgetState }> {
  const now = input.now ?? new Date();
  const withLanes = (lanes: Map<string, AskLane>) =>
    input.rows.map((r) => {
      const lane = lanes.get(r.id);
      return lane ? { ...r, lane } : r;
    });
  let units: AskUnit[] = [];
  try {
    const memberIds = input.rows.flatMap((r) =>
      r.kind === "proposal-cluster" && !r.reviewLater
        ? (r.proposalIds ?? [])
        : []
    );
    units = askUnitsOf(
      input.rows,
      await proposalWaitsOf(input.userId, memberIds)
    );
    if (units.length === 0 && !input.stamp) {
      return {
        rows: [...input.rows],
        budget: { status: "unmeasured", asks: 0, later: 0 },
      };
    }
    const { limit, day } = await readBudgetFrame(input.userId, now);

    const result = await db.transaction(async (tx) => {
      if (input.stamp) await lockDay(tx, input.userId, day);
      const stamps = await readStamps(tx, input.userId, day);
      const first = assignLanes({
        units,
        stamps,
        usedToday: stamps.size,
        limit,
      });
      if (!input.stamp || first.toStamp.length === 0) {
        return { assignment: first, used: stamps.size };
      }
      const base = stamps.size;
      await tx
        .insert(dailyAsks)
        .values(
          first.toStamp.map((u, i) => ({
            userId: input.userId,
            day,
            itemKind: u.itemKind,
            itemId: u.itemId,
            rank: base + i,
            surfacedAt: now,
          }))
        )
        .onConflictDoNothing();
      // Re-read under the lock: the lanes are drawn from what is STORED.
      const after = await readStamps(tx, input.userId, day);
      return {
        assignment: assignLanes({
          units,
          stamps: after,
          usedToday: after.size,
          limit,
        }),
        used: after.size,
      };
    });

    const { lanes } = result.assignment;
    let asks = 0;
    let later = 0;
    for (const lane of lanes.values()) {
      if (lane === "asks") asks += 1;
      else later += 1;
    }
    return {
      rows: withLanes(lanes),
      budget: { status: "measured", limit, day, used: result.used, asks, later },
    };
  } catch (err) {
    logger.warn(
      { err, userId: input.userId, units: units.length },
      "ask budget unreadable — every ask drawn in Asks (fail open)"
    );
    const lanes = new Map<string, AskLane>();
    for (const r of input.rows) {
      if (
        !r.reviewLater &&
        (r.kind === "proposal-cluster" ||
          r.kind === "owed-slot" ||
          r.kind === "access-request")
      ) {
        lanes.set(r.id, "asks");
      }
    }
    return {
      rows: withLanes(lanes),
      budget: { status: "unmeasured", asks: lanes.size, later: 0 },
    };
  }
}

/** What a push may do with today's budget. */
export type AskPushClaim =
  | { push: true; reason: "already_headlined" | "stamped" }
  | { push: false; reason: "later" };

/**
 * May this ask ring the person's phone? A push headlines the ask, so it takes
 * one of today's slots: an ask already stamped today pushes again freely; an
 * unstamped one is stamped while room remains; past the budget it is Later and
 * does NOT push. A failed read pushes (fail open, like the lanes) — the caller
 * logs it; silence on a blocked agent is the costlier miss.
 */
export async function claimAskPush(input: {
  userId: string;
  itemKind: AskItemKind;
  itemId: string;
  now?: Date;
}): Promise<AskPushClaim> {
  const now = input.now ?? new Date();
  const { limit, day } = await readBudgetFrame(input.userId, now);
  const key = stampKey(input.itemKind, input.itemId);
  return db.transaction(async (tx) => {
    await lockDay(tx, input.userId, day);
    const stamps = await readStamps(tx, input.userId, day);
    if (stamps.has(key)) {
      return { push: true as const, reason: "already_headlined" as const };
    }
    if (stamps.size >= limit) {
      return { push: false as const, reason: "later" as const };
    }
    await tx
      .insert(dailyAsks)
      .values({
        userId: input.userId,
        day,
        itemKind: input.itemKind,
        itemId: input.itemId,
        rank: stamps.size,
        surfacedAt: now,
      })
      .onConflictDoNothing();
    return { push: true as const, reason: "stamped" as const };
  });
}

/**
 * Where a NEW ask lands, for the agent that filed it: `later` (with its
 * position) when today's budget is already spent — it will not be headlined
 * today, so the agent keeps working instead of re-asking. `null` when there
 * is room (the next whole-pod read ranks it) or when the budget cannot be read
 * (never a guessed "later"). Reads only; never stamps.
 */
export async function laterPositionForNewAsk(input: {
  userId: string;
  now?: Date;
}): Promise<{ queued: "later"; position: number } | null> {
  try {
    const now = input.now ?? new Date();
    const { limit, day } = await readBudgetFrame(input.userId, now);
    const stamps = await readStamps(db, input.userId, day);
    if (stamps.size < limit) return null;
    const [row] = await db
      .select({ n: drizzleSql<number>`count(*)::int` })
      .from(proposals)
      .where(
        and(
          eq(proposals.subjectUserId, input.userId),
          eq(proposals.status, "pending")
        )
      );
    return { queued: "later", position: Math.max(1, (row?.n ?? 0) - limit) };
  } catch (err) {
    logger.warn(
      { err, userId: input.userId },
      "ask budget unreadable — no queue position on the write result"
    );
    return null;
  }
}
