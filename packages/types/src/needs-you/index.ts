/**
 * needs-you — the ONE shaping rule for a `signals.list` needs-you page, shared
 * by every surface (browser, relay). Pure and dependency-free.
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
  /** `owed-slot` / `draft-asks`: the session goal — the header's name. */
  sessionGoal?: string | null;
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
