/**
 * THE DAILY ASK BUDGET — the PURE half (D7, founder-approved 2026-10-28; plan
 * 9acca984 §M5, report 6e8c654e §3.4). The I/O half, and the ONE place the
 * day's asks are counted, is `ask-budget.ts` beside this file.
 *
 * The budget is on the PERSON's attention, not on the agent's writes. The
 * governance engine still decides WHETHER a person must decide, and every
 * floor holds; the budget decides only WHEN and how loudly they are asked. At
 * most `daily_ask_count` (default 5) asks are headlined per local day — the
 * "Asks" lane. Every other ask waits in "Later": listed and decidable, never
 * pushed, and NEVER auto-approved. A budget that approved things to stay under
 * its number would be the rubber stamp the prior art warns about (R7 §8).
 *
 * THE UNIT OF AN ASK (Q1: a batch counts as one ask). One needs-you row that
 * asks the person something:
 *   - a pending proposal CLUSTER (a pack, a fingerprint group) counts ONCE,
 *     however many members it holds — stamped through one member's id, and
 *     read as stamped when ANY member is (a push stamps one proposal);
 *   - an owed `owner:'human'` slot counts once;
 *   - an access request counts once.
 * Never counted: notifications, receipts, sessions awaiting review, captures,
 * invites, and anything already in Review later (out of the headline by its
 * own rule).
 *
 * THE RANK (who gets today's slots first): an agent waits on it → its review
 * package's stakes (`REVIEW_PACKAGE_ORDER`) → oldest first.
 */

import {
  reviewPackageRank,
  type ReviewPackage,
} from "@synap-core/types/proposals/review-package";

/** Where an ask is drawn today. */
export type AskLane = "asks" | "later";

/** The `daily_asks.item_kind` vocabulary. */
export const ASK_ITEM_KINDS = ["proposal", "slot", "access-request"] as const;
export type AskItemKind = (typeof ASK_ITEM_KINDS)[number];

/** One ask unit, as the budget ranks and stamps it. */
export interface AskUnit {
  /** The needs-you row it stands for (`Signal.id`) — how a lane maps back. */
  rowId: string;
  /** What a NEW stamp records. */
  itemKind: AskItemKind;
  itemId: string;
  /**
   * Every stamp key (`<itemKind>:<itemId>`) that means "this unit is already
   * one of today's asks" — a cluster lists each member it sampled, so a stamp
   * made through any member (a push, an earlier read) holds it.
   */
  stampKeys: string[];
  /** An agent is blocked on it. */
  waits: boolean;
  package: ReviewPackage;
  occurredAt: Date;
}

/** The needs-you row fields the unit derivation reads. */
export interface AskRowInput {
  id: string;
  kind: string;
  occurredAt: Date;
  package?: ReviewPackage;
  reviewLater?: true;
  proposalIds?: string[];
}

export const stampKey = (kind: AskItemKind, id: string) => `${kind}:${id}`;

/**
 * The ask units of a needs-you population, in its order. `proposalWaits`
 * answers "does an agent wait on this proposal" for the clusters' members
 * (absent ⇒ no).
 */
export function askUnitsOf(
  rows: readonly AskRowInput[],
  proposalWaits: (proposalId: string) => boolean = () => false
): AskUnit[] {
  const units: AskUnit[] = [];
  for (const row of rows) {
    if (row.reviewLater) continue;
    const pkg = row.package ?? "data-changes";
    if (row.kind === "proposal-cluster") {
      const members = row.proposalIds ?? [];
      const first = members[0];
      if (!first) continue;
      units.push({
        rowId: row.id,
        itemKind: "proposal",
        itemId: first,
        stampKeys: members.map((id) => stampKey("proposal", id)),
        waits: members.some((id) => proposalWaits(id)),
        package: pkg,
        occurredAt: row.occurredAt,
      });
    } else if (row.kind === "owed-slot") {
      // An owed slot IS work an agent handed back because it could not take
      // it: the agent waits on the answer by construction.
      units.push({
        rowId: row.id,
        itemKind: "slot",
        itemId: row.id,
        stampKeys: [stampKey("slot", row.id)],
        waits: true,
        package: pkg,
        occurredAt: row.occurredAt,
      });
    } else if (row.kind === "access-request") {
      units.push({
        rowId: row.id,
        itemKind: "access-request",
        itemId: row.id,
        stampKeys: [stampKey("access-request", row.id)],
        waits: false,
        package: pkg,
        occurredAt: row.occurredAt,
      });
    }
  }
  return units;
}

/** THE rank: waits → package stakes → oldest → id (a stable tie-break). */
export function rankAskUnits(units: readonly AskUnit[]): AskUnit[] {
  return [...units].sort(
    (a, b) =>
      Number(b.waits) - Number(a.waits) ||
      reviewPackageRank(a.package) - reviewPackageRank(b.package) ||
      a.occurredAt.getTime() - b.occurredAt.getTime() ||
      (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0)
  );
}

export interface LaneAssignment {
  /** rowId → lane, for every unit. */
  lanes: Map<string, AskLane>;
  /** Units to stamp now (unstamped, best-ranked, within today's room). */
  toStamp: AskUnit[];
  /** Units in Later, in rank order (a unit's `position` is its index + 1). */
  later: AskUnit[];
}

/**
 * Assign lanes. `stamps` are today's stamp keys; `usedToday` is today's stamp
 * COUNT (a decided ask still used its slot: five asks a day means five, not
 * five open at once). Stamped units are Asks; while room remains, the
 * best-ranked unstamped units join them (`toStamp`); the rest are Later.
 */
export function assignLanes(input: {
  units: readonly AskUnit[];
  stamps: ReadonlySet<string>;
  usedToday: number;
  limit: number;
}): LaneAssignment {
  const lanes = new Map<string, AskLane>();
  const toStamp: AskUnit[] = [];
  const later: AskUnit[] = [];
  let room = Math.max(0, input.limit - input.usedToday);
  for (const unit of rankAskUnits(input.units)) {
    if (unit.stampKeys.some((k) => input.stamps.has(k))) {
      lanes.set(unit.rowId, "asks");
    } else if (room > 0) {
      room -= 1;
      toStamp.push(unit);
      lanes.set(unit.rowId, "asks");
    } else {
      later.push(unit);
      lanes.set(unit.rowId, "later");
    }
  }
  return { lanes, toStamp, later };
}

/**
 * The person's local day (`YYYY-MM-DD`) in their `users.timezone`. An unknown
 * or empty zone reads as UTC (the column's own default) — never a throw.
 */
export function localDayOf(now: Date, timeZone: string | null | undefined) {
  const zone = timeZone && timeZone.trim() ? timeZone : "UTC";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  }
}
