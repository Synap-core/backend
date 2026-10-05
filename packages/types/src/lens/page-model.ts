/**
 * THE LENS PAGE MODEL — `lensPageModel(page, opts)`: the ONE page read
 * (`signals.list({ lens: "page" })`) → every section a lens draws below its
 * top, plus the header's counts. Web (`browser` `LensPageBody`) and relay
 * (`useLensBody` → `LensBody`) both draw THIS; each platform supplies only
 * its doors (where a "Show all" goes, what a dismiss writes).
 *
 * The rules that used to be decided twice, now decided once here:
 *
 *   - PARTIAL READS. A class with a failed half (`unreadable`) is never shown
 *     as complete: with rows it is `partial` (rows drawn + a retry, NO exact
 *     count — the number the pod sent misses the failed half); without rows it
 *     is `failed`. Its header count is `null` like its section's.
 *   - COUNTS. The header's count doors ARE the sections' counts
 *     (`counts.blocking === blocking.count`, …) — one derivation.
 *   - "SHOW ALL N" counts the class's UNITS on every platform: Needs you /
 *     Proposed = signals (a session card counts its items — the needs-you
 *     badge's unit); Happening = sessions; Produced = outputs; Happened =
 *     today's ACTS (a batched line of 12 counts 12), never lines.
 *   - CAPS. Rows past `LENS_CAPS` are `rest`: behind the host's "Show all"
 *     door, or unfolded in place where the host has no door — never dropped.
 *   - HAPPENED is WORK + DATA: ledger acts and record changes (`event`).
 *   - LAST ACTIVITY is the newest Happened item (work or data).
 *   - DISMISS ({@link lensRowDismissal}): every PROPOSED row can be dismissed
 *     (an agent draft is discarded, an AI suggestion is marked read); a
 *     BLOCKING row never can.
 */

import { needsYouRows, type NeedsYouRow } from "../needs-you/index.js";
import { LENS_CAPS } from "./classes.js";
import {
  NEXT_HOUR_PICKS,
  nextMoveCandidateOfWire,
  nextMoveKeyOfRow,
  rankNextMoves,
  type LensPagePicks,
  type NextMoveCandidate,
  type RankedNextMove,
} from "./next-moves.js";
import type { LensBanner, LensCounts } from "./header.js";
import {
  happenedItems,
  lensBannerOfStatus,
  lensOutputOfSignal,
  lensRowOfLiveSignal,
  type LensPage,
  type LensPageClass,
  type LensPageSignal,
} from "./page.js";
import {
  batchHappenedItems,
  lensRowOfNeedsYou,
  type HappenedDay,
  type HappenedEntry,
  type HappenedItem,
  type LensDoor,
  type LensNeedsYouSignal,
  type LensOutput,
  type LensRow,
} from "./rows.js";

/**
 * What a lens host asks the page read for (`signals.list` `caps`), the same
 * on every platform. Needs you is fetched WHOLE (a page: the needs-you list
 * limit) so a session's items are never split by the server cap before
 * `needsYouRows` groups them — the model caps by ROWS. Proposed is fetched
 * past its cap so the rest can unfold. Happened takes the server maximum and
 * is bounded to the viewer's today by `since`, so today's acts batch whole.
 */
export const LENS_PAGE_READ_CAPS = {
  blocking: 50,
  proposed: 20,
  happened: 100,
} as const;

/**
 * A class's state:
 *   - `ready`   — fully read (empty or not);
 *   - `partial` — a half FAILED but rows came back: draw them with a retry,
 *                 and no exact count;
 *   - `failed`  — a half failed and nothing can be drawn.
 */
export type LensClassStatus = "ready" | "partial" | "failed";

export interface LensClassModel<T> {
  status: LensClassStatus;
  /** Drawn at rest (capped). */
  items: T[];
  /** Read but past the cap — behind "Show all", or unfolded in place. */
  rest: T[];
  /** Units in the class at this scope; `null` when not exactly known (partial / failed). */
  count: number | null;
  /** `count` is a lower bound — the pod's scan was cut ("N+"). */
  floor: boolean;
  /** "Show all N": N in the class's units; `null` when nothing is left out (or N is unknown). */
  showAll: number | null;
}

/** How a Proposed row goes away. */
export type LensDismissAction = "discard-draft" | "dismiss-suggestion";

export interface LensDismissal {
  action: LensDismissAction;
  /** The signal it settles. */
  signalId: string;
  /** The signal's address (a draft's session). */
  door: LensDoor | null;
}

/** A Needs-you / Proposed row, with the signal behind an ITEM row and its dismissal. */
export interface LensPageItem<T> {
  row: LensRow;
  /** The signal behind an ITEM row; null for a session card. */
  signal: T | null;
  /** Non-null exactly when the row may be dismissed ({@link lensRowDismissal}). */
  dismiss: LensDismissal[] | null;
}

export interface LensProducedItem<T> {
  output: LensOutput;
  signal: T;
}

export interface LensPageModel<T> {
  /** System health — ONE banner; null when healthy OR not measured. */
  banner: LensBanner | null;
  blocking: LensClassModel<LensPageItem<T>>;
  happening: LensClassModel<LensRow>;
  produced: LensClassModel<LensProducedItem<T>>;
  proposed: LensClassModel<LensPageItem<T>>;
  /** The span's lines (work + data), batched; `count` is the span's acts. */
  happened: LensClassModel<HappenedEntry>;
  /** `happened.items` regrouped by day (the lines drawn at rest). */
  happenedDays: HappenedDay<HappenedEntry>[];
  /** `happened.rest` regrouped by day (unfolded in place / behind Show all). */
  happenedRestDays: HappenedDay<HappenedEntry>[];
  /** The header's count doors — the SAME numbers as the sections' `count`. */
  counts: LensCounts;
  /** The newest Happened item's instant (ISO), or null. */
  lastActivityAt: string | null;
}

/**
 * THE dismissal rule. A Proposed row is optional reading, so it can always be
 * sent away: an agent DRAFT is discarded, an AI SUGGESTION (a notification)
 * is marked read. A session card in Proposed dismisses each of its items by
 * the same rule. A Blocking row never: something waits on the reader there.
 */
export function lensRowDismissal<T extends LensNeedsYouSignal>(
  row: NeedsYouRow<T>,
  cls: "blocking" | "proposed"
): LensDismissal[] | null {
  if (cls !== "proposed") return null;
  const signals = row.kind === "item" ? [row.signal] : row.items;
  const out: LensDismissal[] = [];
  for (const s of signals) {
    const action: LensDismissAction | null =
      s.kind === "draft-asks"
        ? "discard-draft"
        : s.kind === "notification"
          ? "dismiss-suggestion"
          : null;
    if (action) out.push({ action, signalId: s.id, door: s.target ?? null });
  }
  return out.length > 0 ? out : null;
}

/**
 * Blocking / Proposed rows — grouped by THE needs-you rule (a session owing
 * several things is ONE row) and shaped as lens rows, in the pod's order,
 * each with the signal behind an item row and its dismissal. A Proposed
 * NOTIFICATION (an AI suggestion) never wears the needs-you mark and never
 * earns a verb: its mark is `not_started`, "offered", never "owed".
 */
export function lensItemsOfClass<T extends LensNeedsYouSignal>(
  signals: readonly T[],
  cls: "blocking" | "proposed"
): LensPageItem<T>[] {
  const grouped = needsYouRows(signals);
  return [...grouped.recent, ...grouped.older].map((r) => {
    let row = lensRowOfNeedsYou(r, cls);
    if (
      cls === "proposed" &&
      r.kind === "item" &&
      r.signal.kind === "notification"
    ) {
      row = { ...row, state: { everStarted: false }, verb: null };
    }
    return {
      row,
      signal: r.kind === "item" ? r.signal : null,
      dismiss: lensRowDismissal(r, cls),
    };
  });
}

/**
 * A class's count: the pod's `total` when every half was read, else `null` —
 * a partly failed class has no exact number (the total misses the failed
 * half). The header and the section read THIS, so they cannot disagree.
 */
export function lensClassCount(
  cls: Pick<LensPageClass<unknown>, "total" | "unreadable">
): number | null {
  return cls.unreadable.length === 0 ? cls.total : null;
}

/**
 * Every move a page holds, as candidates for THE ranking (`rankNextMoves`):
 *   - answer — each Blocking row in the section's own order; a session card
 *     (one session owing several things) stands as its FIRST item, so the
 *     move names the exact ask and its own verb ("Answer"), never the card's
 *     "Review 9";
 *   - start  — the page's next-hour picks (`page.picks`), when it was asked;
 *   - watch  — each Happening row.
 */
export function lensNextMoveCandidates<
  T extends LensPageSignal & LensNeedsYouSignal,
>(page: {
  blocking: Pick<LensPageClass<T>, "rows">;
  happening: Pick<LensPageClass<LensPageSignal>, "rows">;
  picks?: Pick<LensPagePicks, "rows"> | null;
}): NextMoveCandidate[] {
  const grouped = needsYouRows(page.blocking.rows);
  const answer: NextMoveCandidate[] = [...grouped.recent, ...grouped.older].map(
    (first) => {
      const lead = first.kind === "session" ? first.items[0] : null;
      const item: NeedsYouRow<T> =
        first.kind === "item" || !lead
          ? first
          : {
              kind: "item",
              key: lead.id,
              signal: lead,
              session: {
                id: first.sessionId,
                title: first.title,
                projectId: first.projectId,
              },
            };
      return { tier: "answer", row: lensRowOfNeedsYou(item, "blocking") };
    }
  );
  const start = (page.picks?.rows ?? []).map(nextMoveCandidateOfWire);
  const watch: NextMoveCandidate[] = page.happening.rows.map((s) => ({
    tier: "watch",
    row: lensRowOfLiveSignal(s),
  }));
  return [...answer, ...start, ...watch];
}

/**
 * The row the header's NEXT MOVE is made of (`lensHeaderModel({ nextMove })`):
 * rank[0] of THE ranking (`rankNextMoves`) over the page's moves — the first
 * Blocking row (as its first item when it is a session card), else, where the
 * page carries picks, the top pick, else the first Happening row. Null when
 * the page holds no move (including when both reads failed: the sections
 * carry the retry).
 *
 * A header page never carries picks (the pod sends them only at pod /
 * workspace scope, for Home, which has no header — skill `lens-page`, the
 * Home exception), so a header's move is always Blocking or Happening; a
 * start row handed to `lensNextMove` reads as no move rather than a wrong one.
 */
export function lensNextMoveRow<T extends LensPageSignal & LensNeedsYouSignal>(
  page: {
    blocking: Pick<LensPageClass<T>, "rows">;
    happening: Pick<LensPageClass<LensPageSignal>, "rows">;
    picks?: Pick<LensPagePicks, "rows"> | null;
  } | null,
  now: Date | number = Date.now()
): LensRow | null {
  if (!page) return null;
  return rankNextMoves(lensNextMoveCandidates(page), now)[0]?.row ?? null;
}

/** The next-hour picker's model (relay Home) — see {@link lensNextHour}. */
export interface LensNextHour {
  /**
   * `ready` — read whole; `partial` — a half failed but picks came back;
   * `failed` — a half failed and nothing can be drawn (never "nothing to do").
   */
  status: LensClassStatus;
  /** The picks at rest, ranked, each with its reason chips. */
  picks: RankedNextMove[];
}

/**
 * THE next-hour picker: the START tier of THE ranking (`rankNextMoves`, the
 * same call the header's move reads), top {@link NEXT_HOUR_PICKS}, minus the
 * rows the viewer skipped while the pod has not yet re-read (`hidden`: wire
 * keys, `nextMoveKeyOfRow`). "Only you can answer" is the Needs-you section
 * right above it — the answer tier, in the same order. Null when the page was
 * read without picks (not asked).
 */
export function lensNextHour<T extends LensPageSignal & LensNeedsYouSignal>(
  page: {
    blocking: Pick<LensPageClass<T>, "rows">;
    happening: Pick<LensPageClass<LensPageSignal>, "rows">;
    picks?: LensPagePicks | null;
  } | null,
  now: Date | number,
  opts: { hidden?: ReadonlySet<string> } = {}
): LensNextHour | null {
  if (!page?.picks) return null;
  const hidden = opts.hidden ?? new Set<string>();
  const picks = rankNextMoves(lensNextMoveCandidates(page), now)
    .filter((m) => m.tier === "start")
    .filter((m) => !hidden.has(nextMoveKeyOfRow(m.row) ?? ""))
    .slice(0, NEXT_HOUR_PICKS);
  return {
    status: statusOf(page.picks, picks.length),
    picks,
  };
}

/** The header's counts straight from a page (or null: nothing read yet). */
export function lensPageCounts(
  page: {
    blocking: Pick<LensPageClass<unknown>, "total" | "unreadable">;
    happening: Pick<LensPageClass<unknown>, "total" | "unreadable">;
    produced: Pick<LensPageClass<unknown>, "total" | "unreadable">;
  } | null
): LensCounts {
  return {
    blocking: page ? lensClassCount(page.blocking) : null,
    happening: page ? lensClassCount(page.happening) : null,
    produced: page ? lensClassCount(page.produced) : null,
  };
}

function statusOf(
  cls: Pick<LensPageClass<unknown>, "unreadable">,
  drawn: number
): LensClassStatus {
  if (cls.unreadable.length === 0) return "ready";
  return drawn > 0 ? "partial" : "failed";
}

const unitsOf = (n: number) =>
  Number.isFinite(n) && n > 1 ? Math.floor(n) : 1;

/**
 * One class: cap `all` at the class's cap, count it in `units`. `extra` says
 * more exists than was read (the pod's `hasMore`, older days); `floor` says
 * `count` is a lower bound.
 */
function classModel<T>(
  cls: Pick<LensPageClass<unknown>, "unreadable">,
  all: T[],
  cap: number,
  units: (item: T) => number,
  count: number | null,
  more: { extra: boolean; floor: boolean }
): LensClassModel<T> {
  const items = all.slice(0, cap);
  const rest = all.slice(items.length);
  const status = statusOf(cls, all.length);
  const shownUnits = items.reduce((n, i) => n + units(i), 0);
  const leftOut =
    rest.length > 0 || more.extra || (count !== null && count > shownUnits);
  const exact = status === "ready" ? count : null;
  return {
    status,
    items,
    rest,
    count: exact,
    floor: exact !== null && more.floor,
    showAll: exact !== null && leftOut ? exact : null,
  };
}

function isoOf(at: string | Date | null | undefined): string | null {
  if (!at) return null;
  const d = at instanceof Date ? at : new Date(at);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function lastActivityOf(items: readonly HappenedItem[]): string | null {
  const first = items[0];
  if (!first) return null;
  return isoOf(
    first.kind === "ledger" ? first.row.occurredAt : first.event.occurredAt
  );
}

/**
 * "Last activity": the newest Happened item — work OR data (a non-record
 * event is no item). The header reads this when it holds the page alone.
 */
export function lensLastActivityAt(
  happened: Pick<LensPageClass<LensPageSignal>, "rows"> | null
): string | null {
  return happened ? lastActivityOf(happenedItems(happened.rows)) : null;
}

/**
 * How much history Happened shows: a session is short-lived, so it shows its
 * WHOLE history (capped, rest behind Show all); every other lens shows today.
 * The host reads with `since` only for `"today"`.
 */
export type LensHappenedSpan = "today" | "all";

export function lensHappenedSpan(scope: { kind: string }): LensHappenedSpan {
  return scope.kind === "session" ? "all" : "today";
}

/** Regroup flat lines (newest first) under the days they came from. */
function regroupDays(
  days: readonly HappenedDay<HappenedEntry>[],
  lines: readonly HappenedEntry[]
): HappenedDay<HappenedEntry>[] {
  const keep = new Set(lines);
  return days
    .map((d) => ({ ...d, lines: d.lines.filter((l) => keep.has(l)) }))
    .filter((d) => d.lines.length > 0);
}

/** THE page model — see the module header for the rules it owns. */
export function lensPageModel<T extends LensPageSignal & LensNeedsYouSignal>(
  page: LensPage<T>,
  opts: { timeZone: string; now?: Date; happened?: LensHappenedSpan }
): LensPageModel<T> {
  const blockingAll = lensItemsOfClass(page.blocking.rows, "blocking");
  const proposedAll = lensItemsOfClass(page.proposed.rows, "proposed");
  const happeningAll = page.happening.rows.map((s) => lensRowOfLiveSignal(s));
  const producedAll = page.produced.rows.flatMap((signal) => {
    const output = lensOutputOfSignal(signal);
    return output ? [{ output, signal }] : [];
  });

  const items = happenedItems(page.happened.rows);
  const days = batchHappenedItems(items, opts);
  const spanDays =
    opts.happened === "all" ? days : days.filter((d) => d.isToday);
  const todayLines = spanDays.flatMap((d) => d.lines);
  const lastActivityAt = lastActivityOf(items);

  const itemUnits = (i: LensPageItem<T>) => unitsOf(i.row.count);
  const ofPod = (cls: LensPageClass<unknown>) => ({
    extra: cls.hasMore,
    floor: cls.truncated,
  });
  const happened = classModel(
    page.happened,
    todayLines,
    LENS_CAPS.happened,
    (l) => l.count,
    todayLines.reduce((n, l) => n + l.count, 0),
    {
      // Older days (no `since`) live behind Show all too.
      extra:
        page.happened.hasMore ||
        (opts.happened !== "all" && days.some((d) => !d.isToday)),
      // More acts exist than were read: today's number is a floor.
      floor: page.happened.hasMore || page.happened.truncated,
    }
  );
  const blocking = classModel(
    page.blocking,
    blockingAll,
    LENS_CAPS.blocking,
    itemUnits,
    lensClassCount(page.blocking),
    ofPod(page.blocking)
  );
  const happening = classModel(
    page.happening,
    happeningAll,
    LENS_CAPS.happening,
    () => 1,
    lensClassCount(page.happening),
    ofPod(page.happening)
  );
  const produced = classModel(
    page.produced,
    producedAll,
    LENS_CAPS.produced,
    () => 1,
    lensClassCount(page.produced),
    ofPod(page.produced)
  );

  return {
    banner: page.statusUnreadable ? null : lensBannerOfStatus(page.status),
    blocking,
    happening,
    produced,
    proposed: classModel(
      page.proposed,
      proposedAll,
      LENS_CAPS.proposed,
      itemUnits,
      lensClassCount(page.proposed),
      ofPod(page.proposed)
    ),
    happened,
    happenedDays: regroupDays(spanDays, happened.items),
    happenedRestDays: regroupDays(spanDays, happened.rest),
    counts: {
      blocking: blocking.count,
      happening: happening.count,
      produced: produced.count,
    },
    lastActivityAt,
  };
}
