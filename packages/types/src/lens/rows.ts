/**
 * THE LENS ROW — one view-model for every row on every lens page, web and relay.
 *
 * `[state glyph][object icon] Title · reason · age        [one verb]`
 * `          source (small door — only when ≠ scope)`
 *
 * This module only SHAPES rows from the reads that already exist. It derives
 * nothing those reads' own rules already answer:
 *   - state      → a `UnitStateInput` for `resolveUnitState` (never a tone);
 *   - grouping   → `needsYouRows` (a session owing several things is ONE row);
 *   - ×N         → `repeatLabel`;
 *   - words      → the vocabulary door (verbs, counts, blocked reasons);
 *   - days       → `calendarDayIn` (the heat's day rule).
 */

import {
  needsYouCountsLabel,
  repeatLabel,
  type GroupableSignal,
  type NeedsYouRow,
} from "../needs-you/index.js";
import type { UnitStateInput } from "../units/state.js";
import {
  resolveActionLabel,
  resolveBlockedReasonLabel,
  resolveNeedsYouItemCount,
} from "../vocabulary/index.js";
import type { ActivityActor, ActivityRow } from "../activity/index.js";
import { calendarDayIn } from "../activity/heat.js";
import type { AttentionClass } from "./classes.js";
import type { LensSource } from "./scope.js";

/** An object-nav address (the `Signal.target` shape). The host routes it. */
export interface LensDoor {
  kind: string;
  id: string;
  /** Optional view reading (`room`), from `OBJECT_NAV_VIEWS`. */
  view?: string;
}

/** The ONE inline verb: an action token + its imperative words. */
export interface LensVerb {
  /** Vocabulary action token (`approve`, `answer`, `review`, `accept`…). */
  action: string;
  /** `resolveActionLabel(action, "imperative")`. */
  label: string;
}

export interface LensRow {
  /** Stable React key. */
  key: string;
  cls: AttentionClass;
  /** Feed `resolveUnitState` — the mark is the shared state, never a hand-picked tone. */
  state: UnitStateInput;
  /** Object kind for the noun + icon (`proposal`, `session`, `owed`, an entity slug…). */
  objectKind: string;
  title: string;
  /** The EXACT ask ("Answer: backup target"), never a generic label. Null = none. */
  reason: string | null;
  /** "×N" when the row stands for N identical things, else null. */
  repeat: string | null;
  /** Provenance. Pass through `visibleSource(row, scope)` before drawing it. */
  source: LensSource | null;
  /** When it happened (ISO), for the age. Null = unknown (no age is drawn). */
  occurredAt: string | null;
  /** At most ONE inline verb. Null = the row itself is the door. */
  verb: LensVerb | null;
  /** Where the row opens. Null = nothing addressable (the row is plain). */
  door: LensDoor | null;
  /** Units this row stands for (a session card's items) — what caps count. */
  count: number;
}

function verb(action: string): LensVerb {
  return { action, label: resolveActionLabel(action, "imperative") };
}

function iso(at: string | Date | null | undefined): string | null {
  if (!at) return null;
  const d = at instanceof Date ? at : new Date(at);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** The fields of a needs-you `Signal` a lens row reads (structural). */
export interface LensNeedsYouSignal extends GroupableSignal {
  title: string;
  category?: string | null;
  target?: LensDoor | null;
  /** `owed-slot`: the one line naming WHICH thing is missing — the exact ask. */
  why?: string | null;
  /** `owed-slot`: the slot's own kind; a criterion slot takes the review verb. */
  slotKind?: string | null;
}

/** The criterion slot kind (`CRITERION_SLOT_KIND`) — a grade owed, not an answer. */
const CRITERION_SLOT = "criterion";

function itemShape(
  s: LensNeedsYouSignal
): Pick<LensRow, "state" | "objectKind" | "reason" | "verb"> {
  switch (s.kind) {
    case "owed-slot":
      return {
        state: { owedFromYou: 1 },
        objectKind: "owed",
        // The agent's own line names the missing thing; the reason label is
        // the fallback, because "Human decision" alone is the generic chip
        // the lens rejects.
        reason:
          s.why?.trim() || resolveBlockedReasonLabel(s.blockedReason) || null,
        verb: verb(s.slotKind === CRITERION_SLOT ? "review" : "answer"),
      };
    case "proposal-cluster":
      return {
        state: { pendingDecisions: Math.max(1, s.count) },
        objectKind: "proposal",
        reason: null,
        verb: verb("approve"),
      };
    case "session-review":
      // A review is a judgement: `needs_review` (scales), the state a pending
      // decision wears — the two share a tone and differ by glyph.
      return {
        state: { pendingDecisions: 1 },
        objectKind: "session",
        reason: null,
        verb: verb("review"),
      };
    case "draft-asks":
      return {
        // Not accepted yet ⇒ nothing has happened in it: `not_started`, never
        // `working` (an agent drafted it; nobody is at it).
        state: { everStarted: false },
        objectKind: "session",
        reason: resolveNeedsYouItemCount("ask", Math.max(1, s.count)),
        verb: verb("accept"),
      };
    default:
      // A notification: the row is the door; no invented verb.
      return {
        state: { owedFromYou: 1 },
        objectKind: s.target?.kind ?? "notification",
        reason: null,
        verb: null,
      };
  }
}

/**
 * A needs-you ROW (from `needsYouRows`) as a lens row of class `cls`
 * (`blocking`, or `proposed` for the drafts `partitionNeedsYou` set aside).
 *
 *   item    → the signal's own row; its session is the provenance source.
 *   session → ONE row naming the session, counting what it owes by kind
 *             (`needsYouCountsLabel`), opening the session.
 */
export function lensRowOfNeedsYou<T extends LensNeedsYouSignal>(
  row: NeedsYouRow<T>,
  cls: AttentionClass
): LensRow {
  if (row.kind === "item") {
    const s = row.signal;
    const shape = itemShape(s);
    return {
      key: row.key,
      cls,
      ...shape,
      title: s.title,
      repeat: repeatLabel(s),
      source: row.session
        ? {
            kind: "session",
            id: row.session.id,
            label: row.session.title ?? "",
          }
        : null,
      occurredAt: iso(s.occurredAt),
      door: s.target ?? null,
      count: 1,
    };
  }
  const owed = row.items.filter((s) => s.kind === "owed-slot").length;
  const decisions = row.items
    .filter((s) => s.kind === "proposal-cluster")
    .reduce((n, s) => n + Math.max(1, s.count), 0);
  return {
    key: row.key,
    cls,
    state:
      owed > 0
        ? { owedFromYou: owed }
        : decisions > 0
          ? { pendingDecisions: decisions }
          : { owedFromYou: row.items.length },
    objectKind: "session",
    title: row.title ?? "",
    reason: needsYouCountsLabel(row.counts),
    repeat: null,
    // The card IS the session: its own source would repeat its title.
    source: null,
    occurredAt: iso(row.newestAt),
    verb: null,
    door: { kind: "session", id: row.sessionId },
    count: row.items.length,
  };
}

/** A unit of work an agent is on right now (the shared "working now" rule decided that). */
export interface LensHappeningInput {
  id: string;
  title: string;
  objectKind: string;
  door: LensDoor | null;
  source: LensSource | null;
  /** When the work started — the age reads as elapsed. */
  startedAt: string | Date | null;
  /** The now-line (`deriveRunActivity(...).nowLine.text`), when known. */
  nowLine?: string | null;
}

/** A Happening row: live state, the now-line as its reason, no verb (it opens). */
export function lensRowOfHappening(input: LensHappeningInput): LensRow {
  return {
    key: input.id,
    cls: "happening",
    state: { running: true },
    objectKind: input.objectKind,
    title: input.title,
    reason: input.nowLine?.trim() || null,
    repeat: null,
    source: input.source,
    occurredAt: iso(input.startedAt),
    verb: null,
    door: input.door,
    count: 1,
  };
}

// ── Happened: day-grouped, batched per actor × act × kind ───────────────────

/** One line of the Happened section: one act, or a batch of identical ones. */
export interface HappenedLine {
  key: string;
  actor: ActivityActor;
  /** Vocabulary action token; words = `resolveActivityVerb(action)` (past). */
  action: string;
  /** The objects' kind — the batch's noun ("12 tasks"). */
  objectKind: string;
  /** The ledger rows this line stands for, newest first. ≥ 1. */
  rows: ActivityRow[];
  /** `rows.length`. */
  count: number;
  /** The newest row's instant. */
  occurredAt: string;
}

export interface HappenedDay {
  /** `YYYY-MM-DD` in the viewer's zone. */
  day: string;
  isToday: boolean;
  lines: HappenedLine[];
}

function actorKey(a: ActivityActor): string {
  if (a.kind === "human") return `human:${a.id}`;
  return `${a.kind}:${a.id ?? a.name ?? "?"}`;
}

/**
 * Group a newest-first ledger page by calendar day (viewer's zone) and batch
 * CONSECUTIVE rows with the same actor, act and object kind into one line
 * ("Agent updated 12 tasks"). Never re-sorts: a batch is a run, so an act in
 * between splits it — merging across it would move the act the ledger placed.
 * A failed row never batches (its error is its own fact).
 */
export function batchHappened(
  rows: readonly ActivityRow[],
  opts: { timeZone: string; now?: Date }
): HappenedDay[] {
  const today = calendarDayIn(
    (opts.now ?? new Date()).getTime(),
    opts.timeZone
  );
  const days: HappenedDay[] = [];
  for (const row of rows) {
    const t = new Date(row.occurredAt).getTime();
    if (!Number.isFinite(t)) continue;
    const day = calendarDayIn(t, opts.timeZone);
    let bucket = days[days.length - 1];
    if (!bucket || bucket.day !== day) {
      bucket = { day, isToday: day === today, lines: [] };
      days.push(bucket);
    }
    const last = bucket.lines[bucket.lines.length - 1];
    const batchable = row.outcome !== "failed";
    if (
      batchable &&
      last &&
      last.rows[0]!.outcome !== "failed" &&
      actorKey(last.actor) === actorKey(row.actor) &&
      last.action === row.action &&
      last.objectKind === row.object.kind
    ) {
      last.rows.push(row);
      last.count += 1;
      continue;
    }
    bucket.lines.push({
      key: row.id,
      actor: row.actor,
      action: row.action,
      objectKind: row.object.kind,
      rows: [row],
      count: 1,
      occurredAt: row.occurredAt,
    });
  }
  return days;
}

/**
 * Happened AT REST: today only, at most `LENS_CAPS.happened` lines — the
 * pulse/heatmap is the overview, the Activity page the rest. `hiddenLines`
 * counts today's lines past the cap.
 */
export function happenedAtRest(
  days: readonly HappenedDay[],
  cap: number
): { today: HappenedLine[]; hiddenLines: number } {
  const today = days.find((d) => d.isToday)?.lines ?? [];
  return {
    today: today.slice(0, cap),
    hiddenLines: Math.max(0, today.length - cap),
  };
}

// ── Produced: one output card model ─────────────────────────────────────────

/**
 * One produced object (or a declared slot not yet produced) — what the ONE
 * output card draws on every lens. The noun + icon come from the host's
 * identity door (an entity reads as its kind), so they are not carried here.
 */
export interface LensOutput {
  key: string;
  /** Object kind (an entity's profile slug when the host resolved one). */
  objectKind: string;
  /** Empty ⇒ the card is led by its noun, never a blank title. */
  title: string;
  /** Null = nothing addressable yet (the card is plain, never a dead button). */
  door: LensDoor | null;
  /** The session that produced it. Pass through `visibleSource` before drawing. */
  source: LensSource | null;
  producedAt: string | null;
  /** An agent produced it — the one place the AI dot is earned. */
  byAgent: boolean;
  /** Declared, not produced yet: the dashed card. */
  expected: boolean;
}
