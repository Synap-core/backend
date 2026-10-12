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
        section("capabilities", "attention", { enabled: 3, unapproved: 13 }),
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

  it("folds the admin alerts in by severity: sync error is degraded, issuer is attention", () => {
    const { rows } = buildNeedsYou({
      sections: [backlog],
      pendingIssuers: [{ id: "iss-1", issuerUrl: "https://idp.example" }],
      syncErrors: [{ id: "peer-1", label: "Laptop", error: "timeout" }],
    });
    expect(rows.map((r) => [r.key, r.tone])).toEqual([
      ["sync_error", "degraded"],
      ["review_backlog", "attention"],
      ["trusted_issuer", "attention"],
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

  it("falls back to the server headline when a known section's detail drifted", () => {
    const { rows } = buildNeedsYou({
      sections: [
        section("review_backlog", "attention", { pending: "15" }, "15 pending"),
      ],
    });
    expect(rows[0]).toMatchObject({
      headline: "15 pending",
      action: { kind: "none" },
    });
  });
});

describe("buildNeedsYou link building", () => {
  it("sends the review backlog to the console queue with a plain headline", () => {
    const [row] = buildNeedsYou({ sections: [backlog] }).rows;
    expect(row.headline).toBe("15 changes waiting for review · oldest 8 days");
    expect(row.action).toEqual({
      kind: "link",
      label: "Review",
      exit: { href: "/audit?section=queue", isDesktopLink: false },
    });
  });

  it("hands unapproved capabilities to the desktop app through openIn", () => {
    const [row] = buildNeedsYou({
      sections: [section("capabilities", "attention", { unapproved: 13 })],
    }).rows;
    expect(row.action).toEqual({
      kind: "link",
      label: "Open in app",
      exit: openIn({ kind: "settings", section: "capabilities" }),
    });
    expect(row.action.kind === "link" && row.action.exit.isDesktopLink).toBe(
      true
    );
  });

  it("links a single addressed failing flow straight to it", () => {
    const [row] = buildNeedsYou({
      sections: [
        section("failed_flows", "degraded", {
          failingFlows: 1,
          failedTotal: 10,
          windowDays: 7,
          flows: [
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
    expect(row.headline).toBe("1 flow failing in the last 7 days");
    expect(row.action).toEqual({
      kind: "link",
      label: "Open flow",
      exit: openIn({ kind: "object", objectKind: "playbook", id: "pb-1" }),
    });
  });

  it("expands several failing flows, sending Chat to Intelligence", () => {
    const [row] = buildNeedsYou({
      sections: [
        section("failed_flows", "degraded", {
          failingFlows: 2,
          flows: [
            {
              flowName: "Nightly digest",
              failedCount: 3,
              flowType: "automation",
              flowId: "au-1",
            },
            { flowName: "Chat", failedCount: 1, hasRunning: false },
          ],
        }),
      ],
    }).rows;
    expect(row.action).toEqual({ kind: "expand", label: "Show flows" });
    expect(row.items).toEqual([
      {
        id: "au-1",
        label: "Nightly digest",
        meta: "failed 3 times",
        exit: openIn({ kind: "object", objectKind: "automation", id: "au-1" }),
      },
      {
        id: "Chat-1",
        label: "Chat",
        meta: "failed 1 time",
        exit: { href: "/intelligence", isDesktopLink: false },
      },
    ]);
  });

  it("expands stuck runs inline with names and ages, no links", () => {
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
    expect(row.action).toEqual({ kind: "expand", label: "Show runs" });
    expect(row.items).toEqual([
      { id: "r1", label: "Sync", meta: "running 30h" },
      { id: "idle-r2", label: "Import", meta: "no progress for 42m" },
    ]);
  });

  it("focuses the single pending issuer and the single failing peer", () => {
    const { rows } = buildNeedsYou({
      sections: [],
      pendingIssuers: [{ id: "a b", issuerUrl: null }],
      syncErrors: [{ id: "peer/1", label: "Laptop", error: "x" }],
    });
    const hrefs = rows.map((r) =>
      r.action.kind === "link" ? r.action.exit.href : null
    );
    expect(hrefs).toEqual([
      "/connectors?focus=peer%2F1",
      "/trust-keys?section=issuers&focus=a%20b",
    ]);
  });

  it("sends several pending issuers to the issuers list without a focus", () => {
    const [row] = buildNeedsYou({
      sections: [],
      pendingIssuers: [
        { id: "a", issuerUrl: null },
        { id: "b", issuerUrl: null },
      ],
    }).rows;
    expect(row.headline).toBe("2 trusted issuers awaiting approval");
    expect(row.action.kind === "link" && row.action.exit.href).toBe(
      "/trust-keys?section=issuers"
    );
  });
});

describe("formatAgeHours", () => {
  it("reads at a glance", () => {
    expect(formatAgeHours(0.2)).toBe("under an hour");
    expect(formatAgeHours(5.4)).toBe("5h");
    expect(formatAgeHours(200)).toBe("8 days");
  });
});
