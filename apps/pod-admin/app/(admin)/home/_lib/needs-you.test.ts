import { describe, expect, it } from "vitest";

import { openIn } from "../../../../lib/open-in";
import {
  buildNeedsYou,
  formatAgeHours,
  NEEDS_YOU_CAP,
  statusLine,
  type DiagnoseSection,
} from "./needs-you";

function section(
  key: string,
  status: DiagnoseSection["status"],
  detail: Record<string, unknown> = {},
  headline = `${key} headline`
): DiagnoseSection {
  return { key, status, headline, detail };
}

const backlog = section("review_backlog", "attention", {
  pending: 15,
  oldestAgeHours: 100,
  mineOutsideLens: 0,
  oldestAgeHoursIncludingOutsideLens: 200,
});

describe("buildNeedsYou ranking", () => {
  it("puts degraded before attention, then orders by section importance", () => {
    const { rows } = buildNeedsYou({
      sections: [
        section("schema_contract", "attention"),
        section("stuck_runs", "degraded", { count: 2, thresholdHours: 24 }),
        backlog,
        section("failed_flows", "degraded", { failingFlows: 1, flows: [] }),
        section("capabilities", "attention", {
          verbsAwaitingEnable: 13,
          capabilitiesAwaitingEnable: 3,
        }),
      ],
    });
    expect(rows.map((r) => r.key)).toEqual([
      "failed_flows",
      "stuck_runs",
      "review_backlog",
      "capabilities",
      "schema_contract",
    ]);
  });

  it("folds failing sync peers in by severity", () => {
    const { rows } = buildNeedsYou({
      sections: [backlog],
      syncErrors: [{ id: "peer-1", label: "Laptop", error: "timeout" }],
    });
    expect(rows.map((r) => [r.key, r.tone])).toEqual([
      ["sync_error", "degraded"],
      ["review_backlog", "attention"],
    ]);
  });

  it("caps the list and counts what it hid", () => {
    const keys = [
      "review_backlog",
      "capabilities",
      "failed_flows",
      "stuck_runs",
      "agent_activity",
      "duplicate_proposals",
      "review_queue",
      "schema_hygiene",
      "schema_contract",
    ];
    const result = buildNeedsYou({
      sections: keys.map((k) => section(k, "attention")),
    });
    expect(result.rows).toHaveLength(NEEDS_YOU_CAP);
    expect(result.hiddenCount).toBe(keys.length - NEEDS_YOU_CAP);
    expect(result.hiddenRows.map((r) => r.key)).toEqual(
      keys.slice(NEEDS_YOU_CAP)
    );
    expect(result.rows.at(-1)?.key).not.toBe("schema_contract");
  });
});

describe("buildNeedsYou ok-collapse", () => {
  it("keeps ok sections out of the rows and lists them as passing", () => {
    const result = buildNeedsYou({
      sections: [
        section("stuck_runs", "ok", {}, "No stuck runs"),
        section("failed_flows", "ok", {}, "No flow failed in the last 7 days"),
        backlog,
      ],
    });
    expect(result.rows.map((r) => r.key)).toEqual(["review_backlog"]);
    expect(result.passing).toEqual([
      { key: "stuck_runs", headline: "No stuck runs" },
      { key: "failed_flows", headline: "No flow failed in the last 7 days" },
    ]);
  });

  it("says all good when nothing needs the owner", () => {
    const result = buildNeedsYou({
      sections: [section("stuck_runs", "ok")],
    });
    expect(statusLine("ok", result)).toEqual({
      tone: "ok",
      sentence: "All good — nothing needs you right now.",
    });
  });

  it("counts hidden rows in the status line and lets an alert raise the tone", () => {
    const result = buildNeedsYou({
      sections: [section("stuck_runs", "ok")],
      syncErrors: [{ id: "p", label: "Peer", error: "boom" }],
    });
    expect(statusLine("ok", result)).toEqual({
      tone: "degraded",
      sentence: "1 thing needs you.",
    });
  });
});

describe("buildNeedsYou unknown and malformed sections", () => {
  it("renders an unknown key with the server headline and no link", () => {
    const { rows } = buildNeedsYou({
      sections: [section("brand_new_check", "degraded", {}, "Something new")],
    });
    expect(rows).toEqual([
      {
        key: "brand_new_check",
        tone: "degraded",
        headline: "Something new",
        action: { kind: "none" },
        items: [],
      },
    ]);
  });

  it("ranks an unknown key after every known one of the same severity", () => {
    const { rows } = buildNeedsYou({
      sections: [
        section("brand_new_check", "attention"),
        section("schema_contract", "attention"),
      ],
    });
    expect(rows.map((r) => r.key)).toEqual([
      "schema_contract",
      "brand_new_check",
    ]);
  });

  it("falls back to the server headline, linked to the section's page, when its detail drifted", () => {
    const { rows } = buildNeedsYou({
      sections: [
        section("review_backlog", "attention", { pending: "15" }, "15 pending"),
      ],
    });
    expect(rows[0]).toMatchObject({
      headline: "15 pending",
      action: {
        kind: "link",
        label: "Open review",
        exit: { href: "/review", isDesktopLink: false },
      },
    });
  });

  it("links a placed section with no row builder to its page", () => {
    const [row] = buildNeedsYou({
      sections: [
        section("quality_by_prompt_version", "attention", {}, "Quality dipped"),
      ],
    }).rows;
    expect(row.headline).toBe("Quality dipped");
    expect(row.action).toEqual({
      kind: "link",
      label: "Open intelligence",
      exit: { href: "/intelligence", isDesktopLink: false },
    });
  });
});

describe("buildNeedsYou link building", () => {
  it("sends the review backlog to Review with a plain headline", () => {
    const [row] = buildNeedsYou({ sections: [backlog] }).rows;
    expect(row.headline).toBe("15 changes waiting for review · oldest 8 days");
    expect(row.action).toEqual({
      kind: "link",
      label: "Review",
      exit: { href: "/review", isDesktopLink: false },
    });
  });

  it("counts verbs not turned on and sends them to Marketplace → Tools (D5)", () => {
    const [row] = buildNeedsYou({
      sections: [
        section("capabilities", "attention", {
          verbsAwaitingEnable: 4,
          capabilitiesAwaitingEnable: 1,
        }),
      ],
    }).rows;
    expect(row.headline).toBe("4 installed verbs not turned on");
    expect(row.secondary).toBe(
      "In 1 capability. Anything that calls them is refused until you turn them on."
    );
    expect(row.action).toEqual({
      kind: "link",
      label: "Turn on in Marketplace",
      exit: { href: "/marketplace?tab=tools", isDesktopLink: false },
    });
  });

  it("falls back to the server headline for an older pod's container count", () => {
    const [row] = buildNeedsYou({
      sections: [
        section(
          "capabilities",
          "attention",
          { enabled: 3, unapproved: 13 },
          "3 capability(ies) approved, 13 awaiting approval"
        ),
      ],
    }).rows;
    expect(row.headline).toBe(
      "3 capability(ies) approved, 13 awaiting approval"
    );
  });

  it("names the worst failing flow and opens Runs", () => {
    const [row] = buildNeedsYou({
      sections: [
        section("failed_flows", "degraded", {
          failingFlows: 2,
          failedTotal: 11,
          windowDays: 7,
          flows: [
            { flowName: "CRM Hygiene", failedCount: 1, flowType: "playbook" },
            {
              flowName: "AI Dev Session",
              failedCount: 10,
              hasRunning: false,
              flowType: "playbook",
              flowId: "pb-1",
            },
          ],
        }),
      ],
    }).rows;
    expect(row.headline).toBe("2 flows failing in the last 7 days");
    expect(row.secondary).toBe("“AI Dev Session” failed 10 times");
    expect(row.action).toEqual({
      kind: "link",
      label: "Open runs",
      exit: { href: "/runs?filter=failing", isDesktopLink: false },
    });
  });

  it("falls back to the failed-run total when no flow is named", () => {
    const [row] = buildNeedsYou({
      sections: [
        section("failed_flows", "degraded", {
          failingFlows: 1,
          failedTotal: 3,
          flows: [],
        }),
      ],
    }).rows;
    expect(row.secondary).toBe("3 failed runs");
  });

  it("sends stuck runs to Sessions, naming the oldest", () => {
    const [row] = buildNeedsYou({
      sections: [
        section("stuck_runs", "degraded", {
          count: 1,
          thresholdHours: 24,
          oldest: [
            { id: "r1", flowType: "playbook", flowName: "Sync", ageHours: 30 },
          ],
          idleCount: 1,
          idlest: [
            { id: "r2", flowName: "Import", ageHours: 1, idleMinutes: 42 },
          ],
        }),
      ],
    }).rows;
    expect(row.headline).toBe("1 run still going after 24h, 1 more idle");
    expect(row.secondary).toBe("Oldest: “Sync”, 30h");
    expect(row.action).toEqual({
      kind: "link",
      label: "Open sessions",
      exit: { href: "/sessions?filter=stuck", isDesktopLink: false },
    });
  });

  it("sends agents at their proposal cap to Agents", () => {
    const [row] = buildNeedsYou({
      sections: [
        section("agent_activity", "attention", { overCap: [{}], nearCap: [] }),
      ],
    }).rows;
    expect(row.action.kind === "link" && row.action.exit.href).toBe("/agents");
  });

  it("links tidy-up items to the page that owns each", () => {
    const [row] = buildNeedsYou({
      sections: [
        section("schema_hygiene", "attention", {
          zeroEntityKinds: [{ profileId: "pr-1", displayName: "Recipe" }],
          neverRunAutomations: [{ id: "au-1", name: "Nightly digest" }],
        }),
      ],
    }).rows;
    expect(row.action).toEqual({ kind: "expand", label: "Show items" });
    expect(row.items.map((i) => i.exit?.href)).toEqual([
      "/kinds?focus=pr-1",
      "/rules?filter=never-ran&focus=au-1",
    ]);
  });

  it("sends a schema-contract drift to Kinds", () => {
    const [row] = buildNeedsYou({
      sections: [section("schema_contract", "attention")],
    }).rows;
    expect(row.action.kind === "link" && row.action.exit.href).toBe("/kinds");
  });

  it("keeps the approve-rate finding's tuning in the app", () => {
    const [row] = buildNeedsYou({
      sections: [section("review_queue", "attention")],
    }).rows;
    expect(row.action).toEqual({
      kind: "link",
      label: "Tune rules",
      exit: openIn({ kind: "settings", section: "ai-governance" }),
    });
  });

  it("lets failing peers expand in place", () => {
    const [sync] = buildNeedsYou({
      sections: [],
      syncErrors: [{ id: "peer/1", label: "Laptop", error: "x" }],
    }).rows;
    expect(sync.action).toEqual({ kind: "expand", label: "Show peers" });
    expect(sync.items).toEqual([{ id: "peer/1", label: "Laptop", meta: "x" }]);
  });
});

describe("buildNeedsYou for a member (D8)", () => {
  const sections = [
    backlog,
    section("failed_flows", "degraded", { failingFlows: 1, flows: [] }),
    section("capabilities", "attention", { verbsAwaitingEnable: 2 }),
    section("review_queue", "attention"),
    section("brand_new_check", "attention", {}, "Something new"),
    section("stuck_runs", "ok", {}, "No stuck runs"),
    section("duplicate_proposals", "ok", {}, "No duplicates"),
  ];

  it("keeps only rows whose page a member can open, plus unplaced keys", () => {
    const result = buildNeedsYou({ sections, audience: "member" });
    expect(result.rows.map((r) => r.key)).toEqual([
      "review_backlog",
      "review_queue",
      "brand_new_check",
    ]);
    expect(result.passing.map((p) => p.key)).toEqual(["duplicate_proposals"]);
  });

  it("shows an admin every row", () => {
    expect(buildNeedsYou({ sections }).rows).toHaveLength(5);
  });
});

describe("formatAgeHours", () => {
  it("reads at a glance", () => {
    expect(formatAgeHours(0.2)).toBe("under an hour");
    expect(formatAgeHours(5.4)).toBe("5h");
    expect(formatAgeHours(200)).toBe("8 days");
  });
});
