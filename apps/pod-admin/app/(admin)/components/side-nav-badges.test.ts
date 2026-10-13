import { describe, expect, it } from "vitest";

import type { DiagnoseSection } from "../home/_lib/needs-you";
import { buildNavBadges } from "./side-nav-badges";

function section(
  key: string,
  status: DiagnoseSection["status"],
  detail: Record<string, unknown> = {}
): DiagnoseSection {
  return { key, status, headline: key, detail };
}

const SECTIONS = [
  section("failed_flows", "degraded", { failingFlows: 2, flows: [] }),
  section("stuck_runs", "attention", { count: 15, idleCount: 2 }),
  section("review_backlog", "attention", { pending: 3 }),
  section("capabilities", "ok", { unapproved: 0 }),
];

describe("buildNavBadges", () => {
  it("badges Home with its needs-you rows and the worst tone", () => {
    const badges = buildNavBadges({
      sections: SECTIONS,
      review: undefined,
      role: "admin",
    });
    expect(badges.home).toEqual({ count: 3, text: "3", tone: "down" });
  });

  it("badges the pages that own a counted section", () => {
    const badges = buildNavBadges({
      sections: SECTIONS,
      review: undefined,
      role: "admin",
    });
    expect(badges.runs).toEqual({ count: 2, text: "2", tone: "down" });
    expect(badges.sessions).toEqual({ count: 17, text: "17", tone: "stale" });
    expect(badges.marketplace).toBeUndefined();
  });

  it("badges Review with signals.count, as a floor when truncated", () => {
    expect(
      buildNavBadges({
        sections: undefined,
        review: { needsYou: 99, truncated: true },
        role: "admin",
      }).review
    ).toEqual({ count: 99, text: "99+", tone: "review" });
    expect(
      buildNavBadges({
        sections: undefined,
        review: { needsYou: 0, truncated: false },
        role: "admin",
      }).review
    ).toBeUndefined();
  });

  it("gives a member only Home and Review, counting only their rows", () => {
    const badges = buildNavBadges({
      sections: SECTIONS,
      review: { needsYou: 4, truncated: false },
      role: "member",
    });
    expect(Object.keys(badges).sort()).toEqual(["home", "review"]);
    // Only review_backlog leads somewhere a member can open.
    expect(badges.home).toEqual({ count: 1, text: "1", tone: "stale" });
  });

  it("badges nothing when every check passes", () => {
    expect(
      buildNavBadges({
        sections: [section("stuck_runs", "ok")],
        review: undefined,
        role: "admin",
      })
    ).toEqual({});
  });
});
