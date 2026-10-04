/**
 * needs-you — the ONE shaping rule for a `signals.list` needs-you page, shared
 * by every surface (browser, relay). Pure; its only imports are this package's
 * own session-title and vocabulary leaves.
 *
 * The SERVER owns order (W2 contract: newest first across every kind, a
 * session's items contiguous at its newest item's position, recent before
 * older — `orderNeedsYou`, `@synap/api` `services/signals/needs-you-union.ts`).
 * This leaf never sorts. It only reads three fields the pod stamps on every
 * row and turns the flat page into what the reader sees:
 *
 * - `groupKey` — every row sharing a `session:<id>` key belongs to ONE
 *   session (adjacent or not — one session is never drawn twice): one row when it is a single item, one card when it is several
 *   ({@link needsYouRows}). Any other key, or none, is a row of its own.
 * - `ageBucket` — `'older'` rows (> 7 days) are split off into the "Older · N"
 *   fold. A fold, never a filter: they still count and still render when
 *   opened. The split is a STABLE partition, so it cannot reorder anything the
 *   server already put in place.
 * - `repeatCount` / `count` — how many identical things one row stands for,
 *   drawn as "×N". KIND-AWARE ({@link repeatOf}): a notification's repeats
 *   are `repeatCount`, a cluster's N proposals are `count`, and nothing else
 *   is a repeat — a draft-asks row's `count` is its number of DISTINCT asks.
 *
 * The three fields are typed REQUIRED, because the pod's `Signal` classifies
 * them universal (every producer, every kind). The reads below still tolerate
 * their absence, deliberately: a client ships ahead of the pods it talks to
 * (a self-hosted pod updates on its own schedule), and a pre-W2 pod omits
 * them. No `groupKey` reads as a group of one, no `ageBucket` as recent, no
 * `repeatCount` as 1 — the absent-field reading of an older wire, not a
 * failure fallback (a failed READ never reaches this leaf).
 */

import { resolveSessionTitle } from "../focus-sessions/title.js";
import { resolveNeedsYouItemCount } from "../vocabulary/index.js";

/** `older` = occurred more than 7 days ago — stamped by the pod, never measured here. */
export type NeedsYouAgeBucket = "recent" | "older";

/** The fields of a needs-you `Signal` this leaf reads. */
export interface GroupableSignal {
  id: string;
  kind: string;
  /**
   * How many underlying things this row stands for: a cluster's proposals, a
   * draft-asks row's DISTINCT asks, a folded notification's repeats; 1
   * otherwise. Not every `count` is a repeat — {@link repeatOf} decides.
   */
  count: number;
  /** `session:<id>` | `proposal-cluster:<key>` | null. */
  groupKey: string | null;
  ageBucket: NeedsYouAgeBucket;
  /** How many identical notifications this ONE row folds (1 otherwise). */
  repeatCount: number;
  /** `owed-slot` / `draft-asks`: the session goal — the name's fallback. */
  sessionGoal?: string | null;
  /**
   * `owed-slot` / `draft-asks` / `session-review`: the session's display name
   * (`resolveSessionTitle`, stamped by the pod). Absent on an older pod, where
   * {@link needsYouRows} falls back to the goal's first line.
   */
  sessionTitle?: string | null;
  /** `owed-slot` / `draft-asks`: the session's project — a card's rail colour. */
  sessionProjectId?: string | null;
  /** `owed-slot`: what would unblock it — the unit a session card counts by. */
  blockedReason?: string | null;
  /** When it happened — a session card's `newestAt`. */
  occurredAt?: string | Date;
}

/** One session's rows (or a lone row) — internal. */
interface Run<T extends GroupableSignal> {
  /** Stable React key: `session:<id>`, or the row's id. */
  key: string;
  /** Set only on a `session:<id>` run. */
  sessionId: string | null;
  items: T[];
}

const SESSION_PREFIX = "session:";

/** The session a group key names, or null when it names anything else. */
export function sessionIdOfGroupKey(
  groupKey: string | null | undefined
): string | null {
  if (!groupKey || !groupKey.startsWith(SESSION_PREFIX)) return null;
  const id = groupKey.slice(SESSION_PREFIX.length);
  return id.length > 0 ? id : null;
}

function pushInto<T extends GroupableSignal>(
  groups: Run<T>[],
  signal: T,
  bySession: Map<string, Run<T>>
): void {
  const sessionId = sessionIdOfGroupKey(signal.groupKey);
  // ONE row per session per fold (needs-you duplicate cause, lens grammar
  // 2026-10-04). The server emits a session's block in one run, so this is a
  // no-op on a well-formed page; when a page does carry the session again
  // after another row (a client merging pages, an older pod), the item joins
  // the session's EXISTING row at that row's position — a session drawn twice
  // is the defect, and the first position is where the server put its newest
  // item. Order inside the run stays the order received.
  if (sessionId) {
    const run = bySession.get(sessionId);
    if (run) {
      run.items.push(signal);
      return;
    }
    const fresh: Run<T> = {
      key: `session:${sessionId}`,
      sessionId,
      items: [signal],
    };
    bySession.set(sessionId, fresh);
    groups.push(fresh);
    return;
  }
  groups.push({ key: signal.id, sessionId: null, items: [signal] });
}

/** Split a server-ordered page into one run per session + the Older partition. */
function runsOf<T extends GroupableSignal>(
  signals: readonly T[]
): { recent: Run<T>[]; older: Run<T>[] } {
  const recent: Run<T>[] = [];
  const older: Run<T>[] = [];
  // Per fold: a session is one row in Recent and, separately, in Older (the
  // pod lifts a session's rows into one bucket, so on its pages that never
  // splits).
  const recentBySession = new Map<string, Run<T>>();
  const olderBySession = new Map<string, Run<T>>();
  for (const s of signals) {
    if (s.ageBucket === "older") pushInto(older, s, olderBySession);
    else pushInto(recent, s, recentBySession);
  }
  return { recent, older };
}

/** The fields ×N reads. Optional: a row from a pre-W2 pod may lack them. */
export interface RepeatableSignal {
  kind?: string | null;
  count?: number | null;
  repeatCount?: number | null;
}

/**
 * How many IDENTICAL things this ONE row stands for — kind-aware:
 *   - `notification` → `repeatCount` (the same news raised N times);
 *   - `proposal-cluster` → `count` (N identical-shape proposals);
 *   - anything else → 1. A `draft-asks` row's `count` is its number of
 *     DISTINCT asks — "asks you 3 things", never "×3" of one thing — and an
 *     owed slot is never a repeat.
 */
export function repeatOf(signal: RepeatableSignal): number {
  const n =
    signal.kind === "notification"
      ? (signal.repeatCount ?? 1)
      : signal.kind === "proposal-cluster"
        ? (signal.count ?? 1)
        : 1;
  return Number.isFinite(n) && n > 1 ? Math.floor(n) : 1;
}

/** "×N", or null at 1 — a "×1" on every row says nothing. */
export function repeatLabel(signal: RepeatableSignal): string | null {
  const n = repeatOf(signal);
  return n > 1 ? `×${n}` : null;
}

// ── One list (founder, 2026-09-28) ─────────────────────────────────────────
//
// The W2 session GROUP (a header over indented items) was rejected: "it was
// clearer to see one list", and retired from every surface. A needs-you page is ONE list of rows, where:
//   - a session owing exactly ONE thing is that thing's own row (an `item`),
//     carrying its session only as quiet provenance;
//   - a session owing TWO OR MORE things is ONE row (a `session` card) that
//     names the session and counts what it owes by kind, and opens the
//     session, where the items live under "Your turn".
// Same server order, same Older fold, one run per session (`runsOf`).

/** Which session a row came from — the provenance door of a single item. */
export interface NeedsYouSessionRef {
  id: string;
  /** Display name: the pod's `sessionTitle`, else the goal's first line. */
  title: string | null;
  projectId: string | null;
}

/** How many things of ONE kind a session owes ("2 decisions"). */
export interface NeedsYouCount {
  /** A {@link needsYouItemKind} key — resolved to words by the vocabulary. */
  kind: string;
  count: number;
}

export type NeedsYouRow<T extends GroupableSignal> =
  | {
      kind: "item";
      /** Stable React key: the signal's id. */
      key: string;
      signal: T;
      /** Set when the item belongs to a session — its provenance door. */
      session: NeedsYouSessionRef | null;
    }
  | {
      kind: "session";
      /** Stable React key: `session:<id>`. */
      key: string;
      sessionId: string;
      /** Display name: the pod's `sessionTitle`, else the goal's first line. */
      title: string | null;
      projectId: string | null;
      /** ≥ 2, in server order — what the optional peek shows. */
      items: T[];
      /** By kind, in order of first appearance. */
      counts: NeedsYouCount[];
      /** The newest item's `occurredAt` (null when no item carries one). */
      newestAt: string | Date | null;
    };

export interface NeedsYouRows<T extends GroupableSignal> {
  recent: NeedsYouRow<T>[];
  older: NeedsYouRow<T>[];
  /** ROWS under the Older fold — a session card is one (what "Older · N" states). */
  olderCount: number;
}

/**
 * The unit a session card counts one signal in: an owed slot by its blocked
 * reason (`owed` when it recorded none), a draft's asks as `ask`, a session
 * awaiting acceptance as `review`, a proposal cluster filed under the session
 * as `decision` (a pending proposal IS a decision), anything else by its
 * signal kind.
 */
export function needsYouItemKind(signal: GroupableSignal): string {
  if (signal.kind === "owed-slot") {
    return signal.blockedReason?.trim().toLowerCase() || "owed";
  }
  if (signal.kind === "draft-asks") return "ask";
  if (signal.kind === "session-review") return "review";
  if (signal.kind === "proposal-cluster") return "decision";
  return signal.kind;
}

/** How many units one signal contributes — a draft row stands for its N asks,
 *  a cluster for its N proposals. */
function unitsOf(signal: GroupableSignal): number {
  if (signal.kind === "draft-asks" || signal.kind === "proposal-cluster") {
    const n = signal.count;
    return Number.isFinite(n) && n > 1 ? Math.floor(n) : 1;
  }
  return 1;
}

function sessionRefOf<T extends GroupableSignal>(
  sessionId: string,
  items: readonly T[]
): NeedsYouSessionRef {
  let title: string | null = null;
  for (const s of items) {
    const t = s.sessionTitle?.trim();
    if (t) {
      title = t;
      break;
    }
  }
  if (!title) {
    for (const s of items) {
      const t = resolveSessionTitle({ goal: s.sessionGoal ?? null });
      if (t) {
        title = t;
        break;
      }
    }
  }
  const projectId = items.find((s) => s.sessionProjectId)?.sessionProjectId;
  return { id: sessionId, title, projectId: projectId ?? null };
}

function timeOf(at: string | Date | undefined): number {
  if (at === undefined) return Number.NaN;
  return (at instanceof Date ? at : new Date(at)).getTime();
}

function toRows<T extends GroupableSignal>(
  groups: readonly Run<T>[]
): NeedsYouRow<T>[] {
  const rows: NeedsYouRow<T>[] = [];
  for (const g of groups) {
    if (!g.sessionId) {
      for (const signal of g.items) {
        rows.push({ kind: "item", key: signal.id, signal, session: null });
      }
      continue;
    }
    const ref = sessionRefOf(g.sessionId, g.items);
    if (g.items.length === 1) {
      const signal = g.items[0]!;
      rows.push({ kind: "item", key: signal.id, signal, session: ref });
      continue;
    }
    const counts: NeedsYouCount[] = [];
    let newestAt: string | Date | null = null;
    for (const s of g.items) {
      const kind = needsYouItemKind(s);
      const hit = counts.find((c) => c.kind === kind);
      if (hit) hit.count += unitsOf(s);
      else counts.push({ kind, count: unitsOf(s) });
      const t = timeOf(s.occurredAt);
      if (!Number.isNaN(t) && (newestAt === null || t > timeOf(newestAt))) {
        newestAt = s.occurredAt!;
      }
    }
    rows.push({
      kind: "session",
      key: g.key,
      sessionId: g.sessionId,
      title: ref.title,
      projectId: ref.projectId,
      items: g.items,
      counts,
      newestAt,
    });
  }
  return rows;
}

/**
 * Shape a server-ordered needs-you page into ONE list of rows + the Older
 * fold. Never sorts: a card sits exactly where its session's first item
 * sat, i.e. at its newest item's position.
 */
export function needsYouRows<T extends GroupableSignal>(
  signals: readonly T[]
): NeedsYouRows<T> {
  const shape = runsOf(signals);
  const older = toRows(shape.older);
  return { recent: toRows(shape.recent), older, olderCount: older.length };
}

/**
 * Cap by ROWS (Home shows ≤ 5): a session card is one row, so a session's
 * items are never split across the cap.
 *
 * - `hiddenRows` — the ROWS left out (a card is one).
 * - `hiddenItems` — the same, in BADGE units: one per signal, a card counting
 *   its items. This is what "+K more" / "Show all N" states, so the number a
 *   reader follows adds up with the needs-you badge (`signals.count`, one per
 *   signal row). A card's own summary keeps its REAL units ("12 decisions"
 *   for a 12-proposal cluster) — that is the work, not the badge.
 */
export function capNeedsYouRows<T extends GroupableSignal>(
  rows: readonly NeedsYouRow<T>[],
  limit: number
): { shown: NeedsYouRow<T>[]; hiddenRows: number; hiddenItems: number } {
  const shown = rows.slice(0, Math.max(0, limit));
  const hidden = rows.slice(shown.length);
  return {
    shown,
    hiddenRows: hidden.length,
    hiddenItems: hidden.reduce(
      (n, r) => n + (r.kind === "session" ? r.items.length : 1),
      0
    ),
  };
}

/** A session card's summary: "2 decisions", "1 action · 1 decision". */
export function needsYouCountsLabel(counts: readonly NeedsYouCount[]): string {
  return counts
    .map((c) => resolveNeedsYouItemCount(c.kind, c.count))
    .join(" · ");
}

/**
 * "POSSIBILITIES", CAPPED — the most AI suggestions (`ai.proactive.*`,
 * `agent.insight`: registry role `suggestion`) any surface is ever handed at
 * once, newest first (V1 W7; founder: "connected tools feed 'possibilities',
 * capped"). Applied server-side, in the ONE partition both the `suggestions`
 * lens and its count read (`needs-you-union.ts`), so the section's number
 * always equals the rows it can show. Older unread suggestions stay in the
 * bell; they are simply not offered as possibilities. A suggestion decays —
 * the five newest are the ones worth a glance.
 */
export const SUGGESTIONS_CAP = 5;
