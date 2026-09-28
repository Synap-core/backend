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
 * - `groupKey` — a run of rows sharing a `session:<id>` key becomes ONE group
 *   under a session header (the header is a door to that session). Any other
 *   key, or none, is a group of one: a cluster already stands for its N.
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

export interface NeedsYouGroup<T extends GroupableSignal> {
  /** Stable React key: the `groupKey`, or the lone row's id. */
  key: string;
  /** Set only on a `session:<id>` group — the header's door. */
  sessionId: string | null;
  items: T[];
}

export interface NeedsYouShape<T extends GroupableSignal> {
  recent: NeedsYouGroup<T>[];
  older: NeedsYouGroup<T>[];
  /** ROWS under the Older fold (what "Older · N" states). */
  olderCount: number;
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
  groups: NeedsYouGroup<T>[],
  signal: T,
  seen: Map<string, number>
): void {
  const sessionId = sessionIdOfGroupKey(signal.groupKey);
  const last = groups[groups.length - 1];
  // Contiguous only: the server emits a session's block in one run. A key that
  // reappears after another row is a NEW header — merging it would move a row
  // the server placed, which is exactly the client re-sort this leaf refuses.
  if (sessionId && last && last.sessionId === sessionId) {
    last.items.push(signal);
    return;
  }
  // Key by the group itself so an answered row does not re-key its siblings;
  // a key the server repeated non-contiguously gets a suffix to stay unique.
  let key = signal.id;
  if (sessionId) {
    const n = seen.get(sessionId) ?? 0;
    seen.set(sessionId, n + 1);
    key = n === 0 ? `session:${sessionId}` : `session:${sessionId}#${n}`;
  }
  groups.push({ key, sessionId, items: [signal] });
}

/** Shape a server-ordered page into session groups + the Older fold. */
export function groupNeedsYou<T extends GroupableSignal>(
  signals: readonly T[]
): NeedsYouShape<T> {
  const recent: NeedsYouGroup<T>[] = [];
  const older: NeedsYouGroup<T>[] = [];
  let olderCount = 0;
  const seen = new Map<string, number>();
  for (const s of signals) {
    if (s.ageBucket === "older") {
      olderCount += 1;
      pushInto(older, s, seen);
    } else {
      pushInto(recent, s, seen);
    }
  }
  return { recent, older, olderCount };
}

/**
 * Cap by GROUPS (Home shows ≤ 5): a session's asks stay together, never split
 * across the fold. `hiddenRows` is the rows the cap left out — what "+K more"
 * states.
 */
export function capNeedsYouGroups<T extends GroupableSignal>(
  groups: readonly NeedsYouGroup<T>[],
  limit: number
): { shown: NeedsYouGroup<T>[]; hiddenRows: number } {
  const shown = groups.slice(0, Math.max(0, limit));
  let hiddenRows = 0;
  for (const g of groups.slice(shown.length)) hiddenRows += g.items.length;
  return { shown, hiddenRows };
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

/** The header's name: the work the session's asks came from. */
export function groupSessionGoal<T extends GroupableSignal>(
  group: NeedsYouGroup<T>
): string | null {
  for (const s of group.items) {
    const goal = s.sessionGoal?.trim();
    if (goal) return goal;
  }
  return null;
}

// ── One list (founder, 2026-09-28) ─────────────────────────────────────────
//
// The session GROUP above (a header over indented items) was rejected: "it was
// clearer to see one list". A needs-you page is ONE list of rows, where:
//   - a session owing exactly ONE thing is that thing's own row (an `item`),
//     carrying its session only as quiet provenance;
//   - a session owing TWO OR MORE things is ONE row (a `session` card) that
//     names the session and counts what it owes by kind, and opens the
//     session, where the items live under "Your turn".
// Same server order, same Older fold, same contiguity rule as `groupNeedsYou`
// (which this builds on, so the two can never disagree on WHICH rows belong
// together — only on how a group is drawn).

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
      /** Stable React key: `session:<id>` (suffixed if the key reappears). */
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
  groups: readonly NeedsYouGroup<T>[]
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
 * fold. Never sorts: a card sits exactly where its session's (contiguous)
 * items sat, i.e. at its newest item's position.
 */
export function needsYouRows<T extends GroupableSignal>(
  signals: readonly T[]
): NeedsYouRows<T> {
  const shape = groupNeedsYou(signals);
  const older = toRows(shape.older);
  return { recent: toRows(shape.recent), older, olderCount: older.length };
}

/**
 * Cap by ROWS (Home shows ≤ 5): a session card is one row, so a session's
 * items are never split across the cap. `hiddenRows` is the rows left out.
 */
export function capNeedsYouRows<T extends GroupableSignal>(
  rows: readonly NeedsYouRow<T>[],
  limit: number
): { shown: NeedsYouRow<T>[]; hiddenRows: number } {
  const shown = rows.slice(0, Math.max(0, limit));
  return { shown, hiddenRows: rows.length - shown.length };
}

/** A session card's summary: "2 decisions", "1 action · 1 decision". */
export function needsYouCountsLabel(counts: readonly NeedsYouCount[]): string {
  return counts
    .map((c) => resolveNeedsYouItemCount(c.kind, c.count))
    .join(" · ");
}
