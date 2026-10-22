/**
 * orient's `startHere.owedByPerson` — what the PERSON owes, so the agent can
 * point them at it.
 *
 * Live, 2026-10-22: the founder asked "where are the decisions I was asked?".
 * Session 6fbc2b5c held three owed `decision` slots with a `choose` ask (Q4,
 * Q5, Q8, owed since 13:29Z) and 7a63ad72 a `form` slot. The agent looked in
 * `startHere.handedToYou` and found none of them — correctly, because that
 * section is the other direction: sessions the person handed TO THE AGENT. No
 * orient section said what the person owes, so the agent could not answer.
 *
 * ONE derivation, no fork: the slots come from `listOwedSlots`
 * (`focus-sessions/owed-outputs.ts`, the owed predicate the Inbox, the homes and
 * the relay read), under the SAME two triage lenses the signals router reads:
 * `excludeDrafts` (the Inbox's "Needs you") and `onlyDrafts` (an undecided
 * agent draft's asks, folded into ONE "Proposed" row per draft — founder lens
 * grammar 2026-10-04, `needs-you-union.ts` `unionProposed`). Each row says
 * which of the two the person will find it under, so the agent can send them
 * to the right place instead of guessing.
 *
 * Folded ONE ROW PER SESSION (deduped), NEWEST owed slot first, capped.
 */

import type { OwedSlot } from "../focus-sessions/owed-outputs.js";

/**
 * Owed slots read per lens. A hit means the counts are lower bounds AND, since
 * `listOwedSlots` keeps the OLDEST under its cap, that the newest rows may be
 * missing — `countIsLowerBound` says so; it is never silently "all".
 */
export const OWED_BY_PERSON_READ_CAP = 500;
/** Session rows listed. */
export const OWED_BY_PERSON_ITEMS = 5;
/** Slot labels named per row. */
const LABELS_PER_ROW = 3;

/** Where the person finds a session's asks in their Inbox. */
export type OwedInbox = "needs-you" | "proposed";

export interface OwedByPerson {
  /** Owed slots across every session (both lenses). */
  count: number;
  /** Sessions holding at least one. */
  sessions: number;
  /** True when a lens hit its read cap — "at least this many". */
  countIsLowerBound: boolean;
  /** The population, stated so it is never read as the agent's own work. */
  lens: "owed-by-person";
  items: Array<{
    sessionId: string;
    title: string | null;
    /** Owed slots on this session. */
    owed: number;
    /** Of those, how many carry an `ask` (answerable in one tap). */
    asks: number;
    /** The newest `owedSince` on this session — the row's order key. */
    newestOwedSince: string;
    /** Up to three slot labels, newest first. */
    labels: string[];
    inbox: OwedInbox;
    link: string;
  }>;
}

/**
 * Fold both lenses into session rows, newest first. Pure. A session appears in
 * one lens only (the triage predicate partitions sessions), so the dedup is a
 * group-by on `sessionId`.
 */
export function foldOwedByPerson(p: {
  needsYou: readonly OwedSlot[];
  proposed: readonly OwedSlot[];
  truncated: boolean;
  link: (sessionId: string) => string;
  limit?: number;
}): OwedByPerson {
  const bySession = new Map<string, { slots: OwedSlot[]; inbox: OwedInbox }>();
  const add = (slots: readonly OwedSlot[], inbox: OwedInbox) => {
    for (const s of slots) {
      const row = bySession.get(s.sessionId);
      if (row) row.slots.push(s);
      else bySession.set(s.sessionId, { slots: [s], inbox });
    }
  };
  add(p.needsYou, "needs-you");
  add(p.proposed, "proposed");

  const newestFirst = (a: OwedSlot, b: OwedSlot) =>
    a.owedSince < b.owedSince ? 1 : a.owedSince > b.owedSince ? -1 : 0;
  const rows = [...bySession].map(([sessionId, { slots, inbox }]) => {
    const sorted = [...slots].sort(newestFirst);
    const head = sorted[0]!;
    return {
      sessionId,
      title: head.sessionTitle ?? head.sessionGoal ?? null,
      owed: sorted.length,
      asks: sorted.filter((s) => s.ask != null).length,
      newestOwedSince: head.owedSince,
      labels: sorted.slice(0, LABELS_PER_ROW).map((s) => s.label),
      inbox,
      link: p.link(sessionId),
    };
  });
  rows.sort((a, b) =>
    a.newestOwedSince < b.newestOwedSince
      ? 1
      : a.newestOwedSince > b.newestOwedSince
        ? -1
        : 0
  );
  return {
    count: p.needsYou.length + p.proposed.length,
    sessions: rows.length,
    countIsLowerBound: p.truncated,
    lens: "owed-by-person",
    items: rows.slice(0, p.limit ?? OWED_BY_PERSON_ITEMS),
  };
}

/**
 * The two reads, at the person's full floor (no workspace lens — the explicit
 * `[]` suppresses the active-workspace default, as `asksYouSessionIds` does).
 * THROWS on a failed read; the caller reports `unavailable`, never zero.
 */
export async function readOwedByPersonSlots(userId: string): Promise<{
  needsYou: OwedSlot[];
  proposed: OwedSlot[];
  truncated: boolean;
}> {
  const { listOwedSlots } = await import("../focus-sessions/owed-outputs.js");
  const { resolveScope } = await import("../../utils/scope-filter.js");
  const scope = resolveScope({}, { workspaceId: [] });
  const [needsYou, proposed] = await Promise.all([
    listOwedSlots({
      userId,
      scope,
      limit: OWED_BY_PERSON_READ_CAP,
      excludeDrafts: true,
    }),
    listOwedSlots({
      userId,
      scope,
      limit: OWED_BY_PERSON_READ_CAP,
      onlyDrafts: true,
    }),
  ]);
  return {
    needsYou,
    proposed,
    truncated:
      needsYou.length >= OWED_BY_PERSON_READ_CAP ||
      proposed.length >= OWED_BY_PERSON_READ_CAP,
  };
}
