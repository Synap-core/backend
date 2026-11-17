/**
 * The pure half of a thing page's "When this moves" block: the rules around
 * one thing, from ONE read (`lifecycle.statusOf` include "reactions", plan
 * 7d71ddcc W3). Two groups, the one that moves it first (what the reader
 * comes for: will it move on its own, and how close is it?), then the ones
 * its own moves set off.
 */

import type { StatusOfReaction } from "@synap-core/types/units";

export type RulesAroundRead =
  StatusOfReaction[] | { status: "unavailable" } | undefined;

export type RulesAroundShown =
  | { kind: "none" }
  | { kind: "failed" }
  | { kind: "ok"; movesIt: StatusOfReaction[]; itSetsOff: StatusOfReaction[] };

/** Omitted when no rule is around it; a failed read is its own state. */
export function rulesAroundToShow(read: RulesAroundRead): RulesAroundShown {
  if (read === undefined) return { kind: "none" };
  if (!Array.isArray(read)) return { kind: "failed" };
  if (read.length === 0) return { kind: "none" };
  return {
    kind: "ok",
    movesIt: read.filter((r) => r.role === "moves"),
    itSetsOff: read.filter((r) => r.role === "fires"),
  };
}

/** What it last did here, in a few words; null when it has not acted yet. */
export function lastOutcomeWords(r: StatusOfReaction): string | null {
  const last = r.last;
  if (!last) return null;
  switch (last.outcome) {
    case "applied":
      return "Last applied";
    case "proposed":
      // A proposal was filed; whether it still waits is its own page's to say.
      return "Last proposed a move";
    case "skipped":
      return `Last skipped: ${last.reason}`;
  }
}

/** The mark beside a rule: paused, or a roll-up's "3 of 5 done". */
export function ruleAroundMark(
  r: StatusOfReaction
): { kind: "healthy" | "stale" | "unknown"; label: string } | null {
  if (r.paused) return { kind: "unknown", label: "Paused" };
  if (r.progress) {
    return {
      kind: r.progress.ready ? "healthy" : "stale",
      label: r.progress.label,
    };
  }
  return null;
}

/** The Rules list's page for one rule. */
export function ruleAroundHref(r: StatusOfReaction): string {
  return `/rules/${encodeURIComponent(r.ruleId)}`;
}
