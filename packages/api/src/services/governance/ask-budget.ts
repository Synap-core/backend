/**
 * THE DAILY ASK BUDGET — the ONE counter (D7, founder 2026-10-28; R7 §3.4).
 *
 * The budget is on the PERSON'S ATTENTION, never on the agents' writes. The
 * governance engine decides whether a person must decide; this decides only
 * whether the ask may INTERRUPT them today. Past `daily_ask_count` (a
 * `governance_ceilings` axis, default 5) an ask is in "Later": listed and
 * decidable, never pushed (`classifyPush`, `askLane: "later"`), and NEVER
 * approved to stay under the number. Nothing here writes: it reads the asks
 * the person was sent and ranks them.
 *
 * WHAT ONE ASK IS. An ask notification (`isAskNotificationType`: a blocking
 * ask, a decision that blocks, a proposal) the person was sent today (UTC,
 * the same day as the daily write ceiling), folded into UNITS:
 *   - a proposal that carries a `batchId` → one unit per batch (Q1: a batch
 *     counts as one ask);
 *   - any other proposal → one unit per fingerprint (`computeProposalFingerprint`:
 *     the same change to the same target, the group the person sees as one
 *     row);
 *   - any other ask → one unit per (type, source).
 * A unit's place is the order its FIRST notification arrived in, so an ask
 * already in Asks never moves to Later when more arrive, and a later member of
 * a unit shares its lane.
 */
import {
  and,
  db,
  eq,
  gte,
  inArray,
  notifications,
  proposals,
} from "@synap/database";
import { resolveCeiling } from "@synap/database/agent-governance";
import {
  ASK_NOTIFICATION_TYPES,
  isAskNotificationType,
  type AskLane,
} from "@synap-core/types/push";
import { computeProposalFingerprint } from "../proposals/fingerprint.js";

/** One ask notification, as the ranking reads it. */
export interface AskNotificationRow {
  id: string;
  createdAt: Date;
  /** The unit it belongs to ({@link askUnitKey}). */
  unitKey: string;
}

export interface RankedAskUnit {
  key: string;
  firstAt: Date;
  /** 1-based place in the day. */
  position: number;
  lane: AskLane;
  notificationIds: string[];
}

/**
 * PURE: fold the day's ask notifications into units and give each its lane.
 * `limit` null = no budget (every unit is in Asks).
 */
export function rankAskUnits(
  rows: readonly AskNotificationRow[],
  limit: number | null
): RankedAskUnit[] {
  const units = new Map<string, { firstAt: Date; ids: string[] }>();
  for (const row of rows) {
    const unit = units.get(row.unitKey);
    if (!unit) {
      units.set(row.unitKey, { firstAt: row.createdAt, ids: [row.id] });
      continue;
    }
    unit.ids.push(row.id);
    if (row.createdAt < unit.firstAt) unit.firstAt = row.createdAt;
  }
  return [...units.entries()]
    .sort(
      ([ka, a], [kb, b]) =>
        a.firstAt.getTime() - b.firstAt.getTime() || ka.localeCompare(kb)
    )
    .map(([key, unit], i) => ({
      key,
      firstAt: unit.firstAt,
      position: i + 1,
      lane: limit === null || i < limit ? "asks" : "later",
      notificationIds: unit.ids,
    }));
}

/** PURE: the unit an ask belongs to (see the file header). */
export function askUnitKey(input: {
  type: string;
  sourceId: string | null;
  notificationId: string;
  proposal?: {
    proposalType: string;
    targetType: string;
    targetId: string;
    data: unknown;
  } | null;
}): string {
  const p = input.proposal;
  if (p) {
    const batchId =
      p.data && typeof p.data === "object"
        ? (p.data as { batchId?: unknown }).batchId
        : undefined;
    if (typeof batchId === "string" && batchId !== "") {
      return `batch:${batchId}`;
    }
    return `fp:${computeProposalFingerprint(p)}`;
  }
  return `${input.type}:${input.sourceId ?? input.notificationId}`;
}

function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The person's `daily_ask_count` (a row naming them, else pod-wide, else 5). */
export async function dailyAskLimit(userId: string): Promise<number> {
  return (
    await resolveCeiling({
      db,
      axis: "daily_ask_count",
      subject: { type: "user", id: userId },
    })
  ).value;
}

export interface AskBudget {
  limit: number;
  /** Start of the counted day (UTC). */
  day: Date;
  units: RankedAskUnit[];
}

/** The person's asks today, ranked into Asks and Later. Read-only. */
export async function askBudget(
  userId: string,
  now: Date = new Date()
): Promise<AskBudget> {
  const day = startOfUtcDay(now);
  // Sequential on purpose: two reads, and a failed one must reject THIS call
  // (the caller logs it), never leave the other promise unhandled.
  const limit = await dailyAskLimit(userId);
  const rows = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      sourceType: notifications.sourceType,
      sourceId: notifications.sourceId,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        inArray(notifications.type, [...ASK_NOTIFICATION_TYPES]),
        gte(notifications.createdAt, day)
      )
    );

  const proposalIds = [
    ...new Set(
      rows
        .filter(
          (r) =>
            r.sourceType === "proposal" &&
            !!r.sourceId &&
            UUID_SHAPE.test(r.sourceId)
        )
        .map((r) => r.sourceId!)
    ),
  ];
  const proposalRows = proposalIds.length
    ? await db
        .select({
          id: proposals.id,
          proposalType: proposals.proposalType,
          targetType: proposals.targetType,
          targetId: proposals.targetId,
          data: proposals.data,
        })
        .from(proposals)
        .where(inArray(proposals.id, proposalIds))
    : [];
  const byId = new Map(proposalRows.map((p) => [p.id, p]));

  const units = rankAskUnits(
    rows.map((r) => ({
      id: r.id,
      createdAt: new Date(r.createdAt),
      unitKey: askUnitKey({
        type: r.type,
        sourceId: r.sourceId,
        notificationId: r.id,
        proposal:
          r.sourceType === "proposal" && r.sourceId
            ? (byId.get(r.sourceId) ?? null)
            : null,
      }),
    })),
    limit
  );
  return { limit, day, units };
}

/**
 * The lane of ONE ask notification already stored (the push decision reads
 * it). `undefined` when the type is not an ask, or the row is not among the
 * day's asks (it is then not counted, and its push is decided as before).
 */
export async function askLaneOfNotification(input: {
  userId: string;
  type: string;
  notificationId: string;
  now?: Date;
}): Promise<AskLane | undefined> {
  if (!isAskNotificationType(input.type)) return undefined;
  const { units } = await askBudget(input.userId, input.now);
  return units.find((u) => u.notificationIds.includes(input.notificationId))
    ?.lane;
}
