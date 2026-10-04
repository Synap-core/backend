/**
 * THE LENS HEADER MODEL (project · track · session — Home has its own top).
 *
 * ```
 * breadcrumb of scope
 * [state mark]  Title                                  [one primary action]
 * one-line narrative: "3 delivered · 1 waiting on you · last activity 2h ago"
 * counts as doors: Needs you 4 · Happening 1 · Produced 12
 * scope fact (ONE): project = target date · track = "Step 3 of 5" · session = "2 of 4 met"
 * ```
 *
 * A count of `null` is a FAILED or absent read — never zero. It drops out of
 * the narrative and its door shows no number, and it can never earn the
 * header's "All clear" mark (calm-confident-wrong is the bug this repo has
 * shipped three times).
 */

import {
  resolveUnitState,
  type UnitStateInput,
  type UnitStateView,
} from "../units/state.js";
import { LENS_SECTION_LABELS } from "./classes.js";
import type { LensScopeKind } from "./scope.js";

export interface LensCounts {
  blocking: number | null;
  happening: number | null;
  produced: number | null;
}

/**
 * The ONE scope fact each header kind carries. Typed per kind, so a project
 * header cannot be handed a step and a session header cannot be handed a date.
 */
export type LensScopeFact =
  | { kind: "target-date"; at: string | null }
  | { kind: "step"; index: number; total: number }
  | { kind: "criteria"; met: number; total: number };

export type LensScopeFactFor<K extends LensScopeKind> = K extends "project"
  ? Extract<LensScopeFact, { kind: "target-date" }>
  : K extends "track"
    ? Extract<LensScopeFact, { kind: "step" }>
    : K extends "session"
      ? Extract<LensScopeFact, { kind: "criteria" }>
      : never;

/** Which fact a header of this scope kind carries — null for the pod / a space. */
export const LENS_SCOPE_FACT_KIND = {
  pod: null,
  workspace: null,
  project: "target-date",
  track: "step",
  session: "criteria",
} as const satisfies Record<LensScopeKind, LensScopeFact["kind"] | null>;

/** The fact's words, or null when the fact is a date (the host formats dates). */
export function lensScopeFactLabel(fact: LensScopeFact): string | null {
  if (fact.kind === "step") {
    return fact.total > 0
      ? `Step ${Math.min(fact.index, fact.total)} of ${fact.total}`
      : null;
  }
  if (fact.kind === "criteria") {
    return fact.total > 0 ? `${fact.met} of ${fact.total} met` : null;
  }
  return null;
}

/** One part of the narrative line. `at` parts are formatted by the host's date door. */
export type LensNarrativePart =
  | { key: "produced" | "blocking" | "happening"; text: string }
  | { key: "last-activity"; at: string };

/** A count shown as a DOOR to its section. `count: null` = unknown (no number). */
export interface LensCountDoor {
  section: "blocking" | "happening" | "produced";
  label: string;
  count: number | null;
}

export interface LensHeaderModel {
  state: UnitStateView;
  narrative: LensNarrativePart[];
  doors: LensCountDoor[];
  /** The REASSURE mark: blocking was READ and is zero. */
  allClear: boolean;
  fact: LensScopeFact | null;
}

function iso(at: string | Date | null | undefined): string | null {
  if (!at) return null;
  const d = at instanceof Date ? at : new Date(at);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function lensHeaderModel<
  K extends Exclude<LensScopeKind, "pod">,
>(input: {
  scopeKind: K;
  state: UnitStateInput;
  counts: LensCounts;
  lastActivityAt?: string | Date | null;
  fact?: LensScopeFactFor<K> | null;
  /**
   * The ONE line that says what matters most right now, in the scope's own
   * words — "Waiting on you: <the exact ask>" or the agent's now-line. It
   * REPLACES that section's count clause and leads the narrative, so the
   * header never says "Waiting on you: X · 1 waiting on you". Absent ⇒ the
   * count clauses alone.
   */
  lead?: { section: "blocking" | "happening"; text: string } | null;
}): LensHeaderModel {
  const { counts } = input;
  const lead = input.lead?.text.trim() ? input.lead : null;
  const narrative: LensNarrativePart[] = [];
  if (lead) narrative.push({ key: lead.section, text: lead.text.trim() });
  if (counts.produced)
    narrative.push({ key: "produced", text: `${counts.produced} delivered` });
  if (counts.blocking && lead?.section !== "blocking") {
    narrative.push({
      key: "blocking",
      text: `${counts.blocking} waiting on you`,
    });
  }
  if (counts.happening && lead?.section !== "happening") {
    narrative.push({
      key: "happening",
      text: `${counts.happening} in progress`,
    });
  }
  const last = iso(input.lastActivityAt);
  if (last) narrative.push({ key: "last-activity", at: last });

  const doors: LensCountDoor[] = (
    ["blocking", "happening", "produced"] as const
  ).map((section) => ({
    section,
    label: LENS_SECTION_LABELS[section],
    count: counts[section],
  }));

  return {
    state: resolveUnitState(input.state),
    narrative,
    doors,
    allClear: counts.blocking === 0,
    fact: input.fact ?? null,
  };
}

// ── The ONE status banner ───────────────────────────────────────────────────

export type LensBannerTone = "error" | "info";

export interface LensBannerInput {
  /** Dedup key — the failing service / condition, not the notification id. */
  key: string;
  tone: LensBannerTone;
  title: string;
  occurredAt?: string | Date | null;
}

export interface LensBanner {
  key: string;
  tone: LensBannerTone;
  title: string;
  /** Other distinct conditions folded under it ("+2 more"). */
  more: number;
}

/**
 * System health is ONE banner, never Needs-you rows: dedupe by `key`, lead
 * with the worst tone (error over info), newest first within a tone. Null
 * when nothing is wrong.
 */
export function lensStatusBanner(
  inputs: readonly LensBannerInput[]
): LensBanner | null {
  const byKey = new Map<string, LensBannerInput>();
  const time = (b: LensBannerInput) => {
    const t = b.occurredAt ? new Date(b.occurredAt).getTime() : Number.NaN;
    return Number.isFinite(t) ? t : 0;
  };
  for (const b of inputs) {
    const prev = byKey.get(b.key);
    if (!prev || time(b) > time(prev)) byKey.set(b.key, b);
  }
  const all = [...byKey.values()].sort((a, b) => {
    if (a.tone !== b.tone) return a.tone === "error" ? -1 : 1;
    return time(b) - time(a);
  });
  const lead = all[0];
  if (!lead) return null;
  return {
    key: lead.key,
    tone: lead.tone,
    title: lead.title,
    more: all.length - 1,
  };
}
