"use client";

/**
 * The nav's badges — actionable counts only (decisions §4: never badge what
 * the owner cannot act on), from the SAME reads the pages under them show:
 *
 *   • Home     — the "Needs you" rows Home builds from `diagnose.global`;
 *   • Review   — `signals.count`, the number browser and relay badge too;
 *   • Sessions — the stuck-runs section; Runs — the failing-flows section.
 *
 * `diagnose.global` is called with Home's own `DIAGNOSE_QUERY_OPTIONS`, so the
 * nav and Home share one cached query rather than racing two.
 */

import {
  DIAGNOSE_DESTINATION,
  type NavAudience,
  type NavId,
} from "../../../lib/console-nav";
import { trpc } from "../../../lib/trpc";
import {
  buildNeedsYou,
  DIAGNOSE_QUERY_OPTIONS,
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

function sectionTone(status: DiagnoseSection["status"]): BadgeTone {
  return status === "degraded" ? "down" : "stale";
}

function num(detail: Record<string, unknown>, key: string): number {
  const v = detail[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** The count a section badges its page with (only the sections that badge). */
const SECTION_COUNT: Partial<
  Record<string, (detail: Record<string, unknown>) => number>
> = {
  stuck_runs: (d) => num(d, "count") + num(d, "idleCount"),
  failed_flows: (d) => num(d, "failingFlows"),
};

/** PURE: every badge from the two reads. Members only get Home + Review. */
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
    const needsYou = buildNeedsYou({ sections, audience: role });
    const all = [...needsYou.rows, ...needsYou.hiddenRows];
    if (all.length > 0) {
      badges.home = {
        count: all.length,
        text: String(all.length),
        tone: all.some((r) => r.tone === "degraded") ? "down" : "stale",
      };
    }
    if (role === "admin") {
      for (const s of sections) {
        const count = SECTION_COUNT[s.key]?.(s.detail) ?? 0;
        const page = DIAGNOSE_DESTINATION[s.key];
        if (s.status === "ok" || count === 0 || !page) continue;
        badges[page] = {
          count,
          text: String(count),
          tone: sectionTone(s.status),
        };
      }
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

export function useConsoleBadges(): NavBadges {
  const role = useConsoleRole();
  const diagnose = trpc.diagnose.global.useQuery(
    undefined,
    DIAGNOSE_QUERY_OPTIONS
  );
  const review = trpc.signals.count.useQuery(undefined, { staleTime: 60_000 });
  return buildNavBadges({
    sections: diagnose.data?.sections,
    review: review.data,
    role,
  });
}
