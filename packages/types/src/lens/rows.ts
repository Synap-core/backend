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
  resolveStatusLabel,
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
  /**
   * An agent raised it (the signal's `ai` category — agent-originated work).
   * Drawn as an AI provenance mark on the row — never on a Proposed row,
   * whose lane heading already carries it. Absent = not known to be an agent.
   * Same name and meaning as `LensOutput.byAgent`.
   */
  byAgent?: boolean;
  /**
   * When an ephemeral ask stops being answerable (ISO) — occurredAt + the
   * server's `lifetimeHours`, never a lifetime this module invented. Read
   * with `lensRowExpiry`. Absent / null = it never expires.
   */
  expiresAt?: string | null;
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
  /** Notification registry type — `placeSignal` reads it for the banner rule. */
  notificationType?: string | null;
  target?: LensDoor | null;
  /** `owed-slot`: the one line naming WHICH thing is missing — the exact ask. */
  why?: string | null;
  /** `owed-slot`: the slot's own kind; a criterion slot takes the review verb. */
  slotKind?: string | null;
  /** Ephemeral lifetime the SERVER carries with the class; null = never expires. */
  lifetimeHours?: number | null;
}

/** The notification category agent-originated work wears (`NOTIFICATION_CATEGORY_LABELS.ai`). */
const AGENT_CATEGORY = "ai";

function expiresAt(
  at: string | Date | null | undefined,
  lifetimeHours: number | null | undefined
): string | null {
  if (lifetimeHours == null || !Number.isFinite(lifetimeHours)) return null;
  const start = iso(at);
  return start
    ? new Date(Date.parse(start) + lifetimeHours * 3_600_000).toISOString()
    : null;
}

/** Inside this much time left, an expiring ask reads urgent (danger tone). */
export const LENS_EXPIRY_URGENT_MS = 60 * 60_000;

/** A row's expiry as its age slot reads it. */
export interface LensRowExpiry {
  /** "Expires in 2h" · "Expires in 22m" · "Expired". */
  label: string;
  /** ≤ `LENS_EXPIRY_URGENT_MS` left, or already expired — the danger tone. */
  urgent: boolean;
  expired: boolean;
}

/**
 * The age slot's EXPIRY variant — web and relay read this, never their own
 * countdown. Null when the row never expires (or its instant is unreadable).
 */
export function lensRowExpiry(
  row: Pick<LensRow, "expiresAt">,
  now: number = Date.now()
): LensRowExpiry | null {
  if (!row.expiresAt) return null;
  const end = Date.parse(row.expiresAt);
  if (!Number.isFinite(end)) return null;
  const left = end - now;
  if (left <= 0)
    return {
      label: resolveStatusLabel("expired"),
      urgent: true,
      expired: true,
    };
  const mins = Math.floor(left / 60_000);
  const span =
    mins < 1
      ? "<1m"
      : mins < 60
        ? `${mins}m`
        : mins < 24 * 60
          ? `${Math.floor(mins / 60)}h`
          : `${Math.floor(mins / (24 * 60))}d`;
  return {
    label: `Expires in ${span}`,
    urgent: left <= LENS_EXPIRY_URGENT_MS,
    expired: false,
  };
}

/**
 * What a section's ONE polite live region says when rows come and go — COUNTS
 * only, never every row ("Needs you: 1 new, 2 cleared"). Web (`LensRowList`)
 * and relay (`LensSection`, `announceForAccessibility`) speak this one string.
 * Null when nothing changed (never announce a no-op).
 */
export function lensRowsChangeMessage(
  label: string,
  { added, removed }: { added: number; removed: number }
): string | null {
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} new`);
  if (removed > 0) parts.push(`${removed} cleared`);
  return parts.length > 0 ? `${label}: ${parts.join(", ")}` : null;
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
      byAgent: s.category === AGENT_CATEGORY,
      expiresAt: expiresAt(s.occurredAt, s.lifetimeHours),
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

export interface HappenedDay<L = HappenedLine> {
  /** `YYYY-MM-DD` in the viewer's zone. */
  day: string;
  isToday: boolean;
  lines: L[];
}

// ── Happened: data events (work + data) ─────────────────────────────────────

/**
 * One DATA change — a record created / changed / removed (the `events` log's
 * completed mutation, `signals.list` kind `event`). Synap is work + data:
 * the ledger says what WORK did, this says what the DATA did — "Sync created
 * 101 contacts" is a Happened line like any other.
 */
export interface LensDataEvent {
  id: string;
  /** Vocabulary action token (`create` / `update` / `delete` / `archive` / `restore`). */
  action: string;
  /** The record's kind — an entity's profile slug when the pod named one. */
  objectKind: string;
  /** The record itself, when addressable. */
  door: LensDoor | null;
  /** ISO instant. */
  occurredAt: string;
  /**
   * WHO wrote it when the pod named a writer other than the default API path
   * (`sync`, `automation`, a connector id). A raw token — words through the
   * service-name door (`resolveServiceName`). Null = no distinct writer.
   */
  origin: string | null;
}

/** One data line: one change, or a batch of identical ones ("Created 101 contacts"). */
export interface HappenedDataLine {
  key: string;
  kind: "data";
  action: string;
  objectKind: string;
  origin: string | null;
  /** Newest first. ≥ 1. */
  events: LensDataEvent[];
  count: number;
  occurredAt: string;
}

/** A Happened line of either kind — what the lens page's Happened draws. */
export type HappenedEntry = HappenedLine | HappenedDataLine;

export function isHappenedDataLine(
  line: HappenedEntry
): line is HappenedDataLine {
  return (line as HappenedDataLine).kind === "data";
}

function actorKey(a: ActivityActor): string {
  if (a.kind === "human") return `human:${a.id}`;
  return `${a.kind}:${a.id ?? a.name ?? "?"}`;
}

/** One newest-first item of a Happened page: a ledger row or a data change. */
export type HappenedItem =
  { kind: "ledger"; row: ActivityRow } | { kind: "data"; event: LensDataEvent };

/**
 * Group a newest-first Happened page — ledger rows AND data changes — by
 * calendar day (viewer's zone) and batch CONSECUTIVE identical acts into one
 * line: same actor × act × kind for the ledger ("Agent updated 12 tasks"),
 * same writer × act × kind for data ("Sync created 101 contacts"). Never
 * re-sorts: a batch is a run, so an act in between splits it — merging across
 * it would move the act the page placed. A failed ledger row never batches
 * (its error is its own fact).
 */
export function batchHappenedItems(
  items: readonly HappenedItem[],
  opts: { timeZone: string; now?: Date }
): HappenedDay<HappenedEntry>[] {
  const today = calendarDayIn(
    (opts.now ?? new Date()).getTime(),
    opts.timeZone
  );
  const days: HappenedDay<HappenedEntry>[] = [];
  for (const item of items) {
    const at =
      item.kind === "ledger" ? item.row.occurredAt : item.event.occurredAt;
    const t = new Date(at).getTime();
    if (!Number.isFinite(t)) continue;
    const day = calendarDayIn(t, opts.timeZone);
    let bucket = days[days.length - 1];
    if (!bucket || bucket.day !== day) {
      bucket = { day, isToday: day === today, lines: [] };
      days.push(bucket);
    }
    const last = bucket.lines[bucket.lines.length - 1];
    if (item.kind === "data") {
      const e = item.event;
      if (
        last &&
        isHappenedDataLine(last) &&
        last.action === e.action &&
        last.objectKind === e.objectKind &&
        last.origin === e.origin
      ) {
        last.events.push(e);
        last.count += 1;
        continue;
      }
      bucket.lines.push({
        key: e.id,
        kind: "data",
        action: e.action,
        objectKind: e.objectKind,
        origin: e.origin,
        events: [e],
        count: 1,
        occurredAt: e.occurredAt,
      });
      continue;
    }
    const row = item.row;
    if (
      row.outcome !== "failed" &&
      last &&
      !isHappenedDataLine(last) &&
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
 * The ledger alone, day-grouped and batched ({@link batchHappenedItems}) —
 * for a surface that reads only `activity.list` (Work › Activity, relay).
 */
export function batchHappened(
  rows: readonly ActivityRow[],
  opts: { timeZone: string; now?: Date }
): HappenedDay[] {
  // Ledger in ⇒ ledger lines out: no data item exists to batch.
  return batchHappenedItems(
    rows.map((row) => ({ kind: "ledger" as const, row })),
    opts
  ) as HappenedDay[];
}

/**
 * Happened AT REST: today only, at most `LENS_CAPS.happened` lines — the
 * pulse/heatmap is the overview, the Activity page the rest. `hiddenLines`
 * counts today's lines past the cap.
 */
export function happenedAtRest<L = HappenedLine>(
  days: readonly HappenedDay<L>[],
  cap: number
): { today: L[]; hiddenLines: number } {
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
