/**
 * The onboarding step "How do you like to review?" (founder B-4) — what it
 * offers and the live preview of the person's OWN waiting items under each
 * choice. Pure: the step only draws this.
 *
 * Shown ONCE: to a person with items waiting and no saved choice
 * (`uiPreferences.review` absent). Choosing — or keeping the default — saves
 * one, and the step never comes back; Settings › Review changes it later.
 */
import { resolveReviewPackageLabel } from "@synap-core/types/vocabulary";
import type { ReviewGroupBy } from "@synap-core/types/proposals/review-package";
import {
  agentGroups,
  itemCount,
  packageGroups,
  sessionGroups,
  type ReviewRow,
  type RowGroup,
} from "./review-rows";

/** The three presets, recommended first (B-4). Product copy. */
export const ONBOARDING_PRESETS: ReadonlyArray<{
  groupBy: ReviewGroupBy;
  name: string;
  badge: string;
  description: string;
}> = [
  {
    groupBy: "package",
    name: "By kind of decision",
    badge: "Recommended",
    description:
      "Questions first, then releases, rules, changes, hand-offs, knowledge. One kind of decision at a time, in order of stakes.",
  },
  {
    groupBy: "work",
    name: "Follow the work",
    badge: "Session-first",
    description:
      "Each piece of work shows its questions and its changes together.",
  },
  {
    groupBy: "agent",
    name: "Follow the agents",
    badge: "Agent-first",
    description:
      "Each agent shows what it asks for. Useful once several agents work for you.",
  },
];

/** Should the step show? Only once it is KNOWN there is no saved choice. */
export function showReviewOnboarding(args: {
  prefsLoaded: boolean;
  prefsFailed: boolean;
  hasSavedChoice: boolean;
  waiting: number;
  narrowed: boolean;
}): boolean {
  return (
    args.prefsLoaded &&
    !args.prefsFailed &&
    !args.hasSavedChoice &&
    args.waiting > 0 &&
    !args.narrowed
  );
}

export interface PreviewLine {
  key: string;
  name: string;
  n: number;
}

/** Lines a preview shows before folding the rest into one. */
const PREVIEW_CAP = 6;

function fold(lines: PreviewLine[], restName: (n: number) => string) {
  if (lines.length <= PREVIEW_CAP) return lines;
  const kept = lines.slice(0, PREVIEW_CAP - 1);
  const rest = lines.slice(PREVIEW_CAP - 1);
  return [
    ...kept,
    {
      key: "rest",
      name: restName(rest.length),
      n: rest.reduce((sum, l) => sum + l.n, 0),
    },
  ];
}

function blockLines(
  groups: RowGroup[],
  noneName: string,
  restName: (n: number) => string
): PreviewLine[] {
  return fold(
    groups.map((g) => ({
      key: g.id ?? "none",
      name: g.title ?? noneName,
      n: itemCount(g.rows),
    })),
    restName
  );
}

/** The person's own waiting items, as each preset would lay them out. */
export function onboardingPreview(
  rows: readonly ReviewRow[],
  groupBy: ReviewGroupBy
): PreviewLine[] {
  switch (groupBy) {
    case "work":
      return blockLines(
        sessionGroups(rows),
        "Not in a session",
        (n) => `${n} other sessions`
      );
    case "agent":
      return blockLines(
        agentGroups(rows),
        "Not from one agent",
        (n) => `${n} other agents`
      );
    case "time":
      return [{ key: "all", name: "Newest first", n: itemCount(rows) }];
    case "package":
      return packageGroups(rows).map((g) => ({
        key: g.package,
        name: resolveReviewPackageLabel(g.package),
        n: itemCount(g.rows),
      }));
  }
}
