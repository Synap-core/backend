/**
 * THE LENS PAGE READ, shaped for the kit — `signals.list({ lens: "page" })`
 * (`api/src/routers/signals.ts`, `LensPageWire`) → the inputs every lens
 * piece draws, on web and relay alike.
 *
 * The pod already classified every row (five classes + one banner), so this
 * module classifies NOTHING. It only shapes each class through the rules that
 * already own it:
 *   - Blocking / Proposed → `needsYouRows` (a session owing several things is
 *     ONE row) → `lensRowOfNeedsYou` (`lensItemsOfClass`, `page-model.ts`);
 *   - Happening           → `lensRowOfHappening` (the pod decided "working
 *     now" with `isSessionWorkingNow`) ({@link lensRowOfLiveSignal});
 *   - Produced            → THE produced card ({@link lensOutputOfSignal});
 *   - Happened            → ledger rows AND data changes, for
 *     `batchHappenedItems` ({@link happenedItems}) — work + data;
 *   - status              → ONE banner, deduped ({@link lensBannerOfStatus}).
 *
 * The wire types are STRUCTURAL — the subset a surface reads — so a client on
 * a vanilla tRPC client (relay) and one on generated types (web) both fit.
 */

import type { ActivityRow } from "../activity/index.js";
import { lensStatusBanner, type LensBanner } from "./header.js";
import {
  type HappenedItem,
  lensRowOfHappening,
  type LensDoor,
  type LensOutput,
  type LensRow,
} from "./rows.js";
import type { LensSource } from "./scope.js";
import { repeatLabel } from "../needs-you/index.js";

/** One `Signal` of the page read — the fields the kit reads. */
export interface LensPageSignal {
  id: string;
  kind: string;
  title: string;
  occurredAt?: string | Date;
  target?: LensDoor | null;
  /** Provenance (`{kind,id,label}`), when the pod named one. */
  source?: LensSource | null;
  /** `live-session` only: the liveness facts the pod judged "working now" by. */
  live?: {
    turnInFlight?: boolean;
    since?: string | Date | null;
    lastAt?: string | Date | null;
  } | null;
  /**
   * `rule-run` only: a rule's runs inside the working window, folded into one
   * row (runs, failures, one in flight). The row's door is the rule.
   */
  ruleRun?: {
    runs: number;
    failed: number;
    running: boolean;
  } | null;
  /** How many identical things the row folds (`rule-run`: its runs). */
  repeatCount?: number;
  /** `output` only: the landed object (`outputs.landed`, `LandedObjectRow`). */
  landed?: {
    kind: string;
    title: string;
    ref: { kind: string; id: string };
    createdAt: string;
    actor?: { kind: string } | null;
    entityProfile?: { slug: string } | null;
  } | null;
  /** `activity` only: the ledger row (`activity.list`). */
  activity?: ActivityRow | null;
  /**
   * `event` only: the DATA change, when the row is a completed mutation of a
   * record (`events` log). Absent on any other event (a governance phase, a
   * connector family) — that row is not a data line.
   */
  event?: {
    action: string;
    objectKind: string;
    origin: string | null;
  } | null;
}

/** One class of the page — `LensClassWire`. */
export interface LensPageClass<T = LensPageSignal> {
  /** The first `cap` rows, in the class's own order. */
  rows: T[];
  /** Rows in the class at this scope — the header's count door. */
  total: number;
  /** `total` is a FLOOR (a scan cap was hit, or a half is unreadable). */
  truncated: boolean;
  /** More exists than `rows` shows ("Show all"). */
  hasMore: boolean;
  /** Halves that FAILED. Non-empty ⇒ partial, never "empty". */
  unreadable: string[];
}

/** One deduplicated health issue (`StatusBannerIssue`). */
export interface LensPageStatusIssue {
  type: string;
  title: string;
  occurredAt: string | Date;
  target?: LensDoor | null;
  /** The notifications behind the condition (the banner's dismiss marks them read). */
  notificationIds?: readonly string[];
}

/** The page — `LensPageWire`. */
export interface LensPage<T = LensPageSignal> {
  blocking: LensPageClass<T>;
  proposed: LensPageClass<T>;
  happening: LensPageClass<T>;
  produced: LensPageClass<T>;
  happened: LensPageClass<T>;
  status: { issues: LensPageStatusIssue[] } | null;
  /** The health read failed: `status: null` then means NOT MEASURED. */
  statusUnreadable: boolean;
}

/** A class is fully READ when none of its halves failed; a partial read is a floor. */
export function lensClassReadable(
  cls: Pick<LensPageClass<unknown>, "unreadable">
): boolean {
  return cls.unreadable.length === 0;
}

/**
 * A `live-session` signal as a Happening row: elapsed from the in-flight
 * turn's start, else from the newest activity. `nowLine` is the host's
 * `deriveRunActivity` line when it has one.
 */
export function lensRowOfLiveSignal(
  signal: LensPageSignal,
  nowLine?: string | null
): LensRow {
  const base = lensRowOfHappening({
    id: signal.id,
    title: signal.title,
    objectKind: signal.target?.kind ?? "session",
    door: signal.target ?? null,
    source: signal.source ?? null,
    startedAt:
      signal.live?.since ?? signal.live?.lastAt ?? signal.occurredAt ?? null,
    nowLine: nowLine ?? null,
  });
  // A RULE running without a session (`rule-run`): its runs are folded into
  // this one row. A failure inside the window is the mark — it outranks the
  // healthy runs beside it — and the repeat says how many runs it stands for.
  const rule = signal.ruleRun;
  if (!rule) return base;
  return {
    ...base,
    state: rule.failed > 0 ? { failed: true } : { running: true },
    repeat: repeatLabel(signal),
  };
}

/**
 * An `output` signal as THE produced card, or null for any other row (a
 * naive cast would draw it). An entity reads as its kind (the profile slug
 * feeds the host's identity door); the AI dot is earned only by an agent.
 */
export function lensOutputOfSignal(signal: LensPageSignal): LensOutput | null {
  const landed = signal.landed;
  if (signal.kind !== "output" || !landed) return null;
  return {
    key: signal.id,
    objectKind: landed.entityProfile?.slug ?? landed.ref.kind ?? landed.kind,
    title: landed.title,
    door: landed.ref.id ? { kind: landed.ref.kind, id: landed.ref.id } : null,
    source: signal.source ?? null,
    producedAt: landed.createdAt || null,
    byAgent: landed.actor?.kind === "agent",
    expected: false,
  };
}

/**
 * The Happened class as WORK + DATA, in the pod's order, for
 * `batchHappenedItems`: each ledger row, and each data change the pod named
 * (`event` signals carrying `event`). An event the pod could not read as a
 * record change is not a data line and is left out — never drawn as a raw
 * token. (Under a project or track the pod sends no events: they carry no
 * project column, so that Happened is the ledger alone.)
 */
export function happenedItems(
  signals: readonly LensPageSignal[]
): HappenedItem[] {
  const out: HappenedItem[] = [];
  for (const s of signals) {
    if (s.activity) {
      out.push({ kind: "ledger", row: s.activity });
      continue;
    }
    const e = s.kind === "event" ? s.event : null;
    const at = s.occurredAt
      ? s.occurredAt instanceof Date
        ? s.occurredAt.toISOString()
        : s.occurredAt
      : null;
    if (!e || !at) continue;
    out.push({
      kind: "data",
      event: {
        id: s.id,
        action: e.action,
        objectKind: e.objectKind,
        door: s.target ?? null,
        occurredAt: at,
        origin: e.origin,
      },
    });
  }
  return out;
}

/**
 * The page's health as THE one banner — deduped by condition (type + target),
 * newest first, the rest folded as "+N more". Null when nothing is wrong.
 * (A FAILED health read is `statusUnreadable`, never this null.)
 */
export function lensBannerOfStatus(
  status: Pick<NonNullable<LensPage["status"]>, "issues"> | null | undefined
): LensBanner | null {
  return lensStatusBanner(
    (status?.issues ?? []).map((i) => ({
      key: `${i.type}|${i.target ? `${i.target.kind}:${i.target.id}` : ""}`,
      tone: "error" as const,
      title: i.title,
      occurredAt: i.occurredAt,
      target: i.target ?? null,
      notificationIds: i.notificationIds ?? [],
    }))
  );
}
