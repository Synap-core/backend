/**
 * THE LENS PAGE READ, shaped for the kit — `signals.list({ lens: "page" })`
 * (`api/src/routers/signals.ts`, `LensPageWire`) → the inputs every lens
 * piece draws, on web and relay alike.
 *
 * The pod already classified every row (five classes + one banner), so this
 * module classifies NOTHING. It only shapes each class through the rules that
 * already own it:
 *   - Blocking / Proposed → `needsYouRows` (a session owing several things is
 *     ONE row) → `lensRowOfNeedsYou` ({@link lensRowsOfClass});
 *   - Happening           → `lensRowOfHappening` (the pod decided "working
 *     now" with `isSessionWorkingNow`) ({@link lensRowOfLiveSignal});
 *   - Produced            → THE produced card ({@link lensOutputOfSignal});
 *   - Happened            → the ledger rows, for `batchHappened`
 *     ({@link happenedLedgerRows});
 *   - status              → ONE banner, deduped ({@link lensBannerOfStatus}).
 *
 * The wire types are STRUCTURAL — the subset a surface reads — so a client on
 * a vanilla tRPC client (relay) and one on generated types (web) both fit.
 */

import type { ActivityRow } from "../activity/index.js";
import { needsYouRows } from "../needs-you/index.js";
import { lensStatusBanner, type LensBanner } from "./header.js";
import {
  lensRowOfHappening,
  lensRowOfNeedsYou,
  type LensDoor,
  type LensNeedsYouSignal,
  type LensOutput,
  type LensRow,
} from "./rows.js";
import type { LensSource } from "./scope.js";

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
 * Blocking or Proposed rows, grouped by the ONE needs-you rule and shaped as
 * lens rows in the pod's order (recent, then older — the page is already
 * capped, so there is no fold to draw).
 *
 * A Proposed NOTIFICATION (an AI suggestion) is optional reading: it never
 * wears the needs-you mark and never earns a verb (its act is to open it, or
 * dismiss it). Its mark is `not_started` — the same quiet state a draft
 * wears — so the lane reads as "offered", never as "owed".
 */
export function lensRowsOfClass<T extends LensNeedsYouSignal>(
  signals: readonly T[],
  cls: "blocking" | "proposed"
): LensRow[] {
  const grouped = needsYouRows(signals);
  return [...grouped.recent, ...grouped.older].map((r) => {
    const row = lensRowOfNeedsYou(r, cls);
    if (
      cls === "proposed" &&
      r.kind === "item" &&
      r.signal.kind === "notification"
    ) {
      return { ...row, state: { everStarted: false }, verb: null };
    }
    return row;
  });
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
  return lensRowOfHappening({
    id: signal.id,
    title: signal.title,
    objectKind: signal.target?.kind ?? "session",
    door: signal.target ?? null,
    source: signal.source ?? null,
    startedAt:
      signal.live?.since ?? signal.live?.lastAt ?? signal.occurredAt ?? null,
    nowLine: nowLine ?? null,
  });
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
 * The Happened class as ledger rows, in order, for `batchHappened`. A data
 * EVENT carries no ledger row and is left out (it is not a ledger line).
 */
export function happenedLedgerRows(
  signals: readonly LensPageSignal[]
): ActivityRow[] {
  const out: ActivityRow[] = [];
  for (const s of signals) if (s.activity) out.push(s.activity);
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
    }))
  );
}
