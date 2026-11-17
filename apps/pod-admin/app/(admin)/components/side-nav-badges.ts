"use client";

/**
 * The nav's badges — actionable counts only (decisions §4: never badge what
 * the owner cannot act on), from the SAME reads the pages under them show:
 *
 *   • Home     — the "Needs you" rows Home builds from `diagnose.global`
 *                (the review backlog left to Requests, `homeSections`);
 *   • Review   — `signals.count`, the number browser and relay badge too.
 *
 * Jobs and Runs, which badged the stuck-runs and failing-flows sections, left
 * the console (`WORK_MOVED_TO_APP`); those sections now count on Home only.
 *
 * `diagnose.global` is called with the shared `DIAGNOSE_QUERY_OPTIONS`, so the
 * nav and Home share one cached query rather than racing two.
 */

import { type NavAudience, type NavId } from "../../../lib/console-nav";
import { trpc } from "../../../lib/trpc";
import { DIAGNOSE_QUERY_OPTIONS } from "../../../lib/diagnose-query";
import {
  buildNeedsYou,
  homeSections,
  type DiagnoseSection,
} from "../home/_lib/needs-you";
import { useConsoleRole } from "./side-nav-role";

/** `down`/`stale` follow StatusPill's palette; `review` is a decision, not a fault. */
export type BadgeTone = "down" | "stale" | "review";

export interface NavBadge {
  count: number;
  /** What renders: the count, or "N+" when the server's number is a floor. */
  text: string;
  tone: BadgeTone;
}

export type NavBadges = Partial<Record<NavId, NavBadge>>;

/** PURE: every badge from the two reads: Home and Review, for every role. */
export function buildNavBadges({
  sections,
  review,
  role,
}: {
  sections: DiagnoseSection[] | undefined;
  review: { needsYou: number; truncated: boolean } | undefined;
  role: NavAudience;
}): NavBadges {
  const badges: NavBadges = {};

  if (sections) {
    const needsYou = buildNeedsYou({
      sections: homeSections(sections),
      audience: role,
    });
    const all = [...needsYou.rows, ...needsYou.hiddenRows];
    if (all.length > 0) {
      badges.home = {
        count: all.length,
        text: String(all.length),
        tone: all.some((r) => r.tone === "degraded") ? "down" : "stale",
      };
    }
  }

  if (review && review.needsYou > 0) {
    badges.review = {
      count: review.needsYou,
      text: review.truncated ? `${review.needsYou}+` : String(review.needsYou),
      tone: "review",
    };
  }

  return badges;
}

/**
 * Review's number (`signals.count`). Every reader — the nav badge, Review's
 * "showing N of M" — goes through here, so they share one cached query and
 * can never show two different numbers.
 */
export function useNeedsYouCount() {
  return trpc.signals.count.useQuery(undefined, {
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}

export function useConsoleBadges(): NavBadges {
  const role = useConsoleRole();
  const diagnose = trpc.diagnose.global.useQuery(
    undefined,
    DIAGNOSE_QUERY_OPTIONS
  );
  const review = useNeedsYouCount();
  return buildNavBadges({
    sections: diagnose.data?.sections,
    review: review.data,
    role,
  });
}
