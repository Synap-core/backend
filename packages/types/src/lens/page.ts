/**
 * THE LENS PAGE READ, shaped for the kit — `signals.list({ lens: "page" })`
 * (`api/src/routers/signals.ts`, `LensPageWire`) → the inputs every lens
 * piece draws, on web and relay alike.
 *
 * The pod already classified every row (five classes + one banner), so this
 * module classifies NOTHING. It only shapes each class through the rules that
 * already own it:
 *   - Blocking / Proposed → `needsYouRows` (a session owing several things is
 *     ONE row) → `lensRowOfNeedsYou`;
 *   - Happening           → `lensRowOfHappening` (the pod decided "working
 *     now" with `isSessionWorkingNow`);
 *   - Produced            → {@link lensOutputOfLanded} (the ONE produced card);
 *   - Happened            → the ledger rows, for `batchHappened`;
 *   - status              → `lensStatusBanner` (dedupe, worst first).
 *
 * The wire types here are STRUCTURAL — the subset a surface reads — so a
 * client talking to the pod through a vanilla tRPC client (relay) and one
 * through generated types (web) both fit.
 */

import type { ActivityRow } from "../activity/index.js";
import type { LandedObjectRow } from "../landed/index.js";
import type { SessionActivityLive } from "../run-activity/wire.js";
import { needsYouRows } from "../needs-you/index.js";
import { lensStatusBanner, type LensBanner } from "./header.js";
import {
  lensRowOfHappening,
  lensRowOfNeedsYou,
  type LensNeedsYouSignal,
  type LensOutput,
  type LensRow,
} from "./rows.js";
import type { LensSource } from "./scope.js";

/** One `Signal` of the page read — the fields the kit reads. */
export interface LensPageSignal extends LensNeedsYouSignal {
  /** Provenance (`{kind,id,label}`), when the pod named one. */
  source?: LensSource | null;
  /** `live-session` only: the liveness facts the pod judged "working now" by. */
  live?: SessionActivityLive | null;
  /** `output` only: the landed object (`outputs.landed`). */
  landed?: LandedObjectRow | null;
  /** `activity` only: the ledger row (`activity.list`). */
  activity?: ActivityRow | null;
}

/** One class of the page — `LensClassWire`. */
export interface LensPageClass<T extends LensPageSignal = LensPageSignal> {
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
  repeatCount: number;
}

/** The page — `LensPageWire`. */
export interface LensPage<T extends LensPageSignal = LensPageSignal> {
  blocking: LensPageClass<T>;
  proposed: LensPageClass<T>;
  happening: LensPageClass<T>;
  produced: LensPageClass<T>;
  happened: LensPageClass<T>;
  status: {
    title: string;
    occurredAt: string | Date;
    issues: LensPageStatusIssue[];
  } | null;
  /** The health read failed: `status: null` then means NOT MEASURED. */
  statusUnreadable: boolean;
}

/** A class is READ when none of its halves failed; a partial read is a floor. */
export function lensClassReadable(
  cls: Pick<LensPageClass, "unreadable">
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
export function lensRowsOfClass<T extends LensPageSignal>(
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

/** A `live-session` signal as a Happening row (elapsed from the turn, else the last act). */
export function lensRowOfLiveSignal(signal: LensPageSignal): LensRow {
  return lensRowOfHappening({
    id: signal.id,
    title: signal.title,
    objectKind: signal.target?.kind ?? "session",
    door: signal.target ?? null,
    source: signal.source ?? null,
    startedAt:
      signal.live?.since ?? signal.live?.lastAt ?? signal.occurredAt ?? null,
    nowLine: null,
  });
}

/**
 * A landed object as THE produced card. An entity reads as its kind (the
 * profile slug feeds the host's identity door); the session that made it is
 * the source; the AI dot is earned only by an agent actor.
 */
export function lensOutputOfLanded(row: LandedObjectRow): LensOutput {
  return {
    key: row.id,
    objectKind: row.entityProfile?.slug ?? row.ref.kind ?? row.kind,
    title: row.title,
    door: row.ref.id ? { kind: row.ref.kind, id: row.ref.id } : null,
    source: row.session?.id
      ? { kind: "session", id: row.session.id, label: row.session.title }
      : null,
    producedAt: row.createdAt || null,
    byAgent: row.actor?.kind === "agent",
    expected: false,
  };
}

/** The Produced class as cards (rows without a landed object are skipped, never invented). */
export function lensOutputsOfPage(
  signals: readonly LensPageSignal[]
): LensOutput[] {
  const out: LensOutput[] = [];
  for (const s of signals) if (s.landed) out.push(lensOutputOfLanded(s.landed));
  return out;
}

/**
 * The Happened class as ledger rows, newest first, for `batchHappened`.
 * A data EVENT row carries no ledger row; it is not drawn as a ledger line.
 */
export function lensLedgerOfPage(
  signals: readonly LensPageSignal[]
): ActivityRow[] {
  const out: ActivityRow[] = [];
  for (const s of signals) if (s.activity) out.push(s.activity);
  return out;
}

/** The page's health as THE one banner, or null when nothing is wrong (or unmeasured). */
export function lensBannerOfPage(
  page: Pick<LensPage, "status">
): LensBanner | null {
  const issues = page.status?.issues ?? [];
  return lensStatusBanner(
    issues.map((i) => ({
      key: i.type || i.title,
      tone: "error" as const,
      title: i.title,
      occurredAt: i.occurredAt,
    }))
  );
}
