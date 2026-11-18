import { describe, expect, it } from "vitest";
import { catalogProblems } from "@synap-core/types/i18n";
import {
  auditEntry,
  capGroups,
  dayGroups,
  decisionAction,
  decisionEntry,
  rowCount,
} from "./timeline-model";
import { en, fr } from "./copy";

const decision = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  status: "approved",
  proposalType: "create",
  targetType: "contact",
  title: "Created contact Léa",
  decidedAt: "2026-11-18T09:00:00Z",
  decidedBy: "Alice",
  askedBy: "Scout",
  ...over,
});

describe("decisionEntry", () => {
  it("reads once: the title's own verb is the act, not 'Approved Created…'", () => {
    const e = decisionEntry(decision());
    expect(e.text).toBe("Created contact Léa");
    expect(e.who).toBe("Alice");
    expect(e.door).toEqual({ kind: "proposal", id: "p1" });
    expect(e.mark.tone).toBe("success");
  });

  it("falls back to what was decided when the title leads with no verb", () => {
    const d = decision({ proposalType: "dev_deploy", title: "Push of a524c103 to main" });
    expect(decisionAction(d)).toBe("approve");
    expect(decisionEntry(d).text).toBe("Approved Push of a524c103 to main");
  });

  it("a rejected request is not marked done", () => {
    const e = decisionEntry(decision({ status: "rejected", proposalType: null, title: "Add Léa" }));
    expect(e.action).toBe("reject");
    expect(e.mark.state).toBe("rejected");
    expect(e.mark.tone).not.toBe("success");
  });

  it("a failed receipt is a failed entry", () => {
    const e = decisionEntry(decision({ status: "approval_failed", decidedBy: null }));
    expect(e.failed).toBe(true);
    expect(e.who).toBe("Scout");
  });
});

describe("auditEntry", () => {
  const audit = (over: Record<string, unknown> = {}) => ({
    id: "a1",
    timestamp: "2026-11-18T09:00:00Z",
    action: "rotate",
    phase: "completed",
    subject: "API key ab12cd…ef34",
    subjectType: "api_keys",
    subjectId: "ab12cd-ef34",
    userId: "u1",
    actorName: "bob@x.io",
    ...over,
  });

  it("speaks the log's action through the vocabulary, with the page's subject", () => {
    const e = auditEntry(audit());
    expect(e.who).toBe("bob@x.io");
    expect(e.verb).toBe("Replaced");
    expect(e.text).toBe("Replaced API key ab12cd…ef34");
    expect(e.key).toBe("a1");
  });

  it("a failed phase is a failed entry", () => {
    expect(auditEntry(audit({ phase: "failed" })).failed).toBe(true);
  });
});

describe("day groups and the cap", () => {
  const entries = [
    decisionEntry(decision({ id: "a", decidedAt: "2026-11-18T10:00:00Z" })),
    decisionEntry(decision({ id: "b", decidedAt: "2026-11-18T08:00:00Z" })),
    decisionEntry(decision({ id: "c", decidedAt: "2026-11-17T08:00:00Z" })),
  ];
  const groups = dayGroups(entries, "UTC", new Date("2026-11-18T12:00:00Z"));

  it("groups by day, newest order kept, today marked", () => {
    expect(groups.map((g) => g.key)).toEqual(["day:2026-11-18", "day:2026-11-17"]);
    expect(groups[0]!.label).toMatchObject({ isToday: true });
    expect(rowCount(groups)).toBe(3);
  });

  it("caps across groups and drops an emptied group", () => {
    expect(rowCount(capGroups(groups, 2))).toBe(2);
    expect(capGroups(groups, 2)).toHaveLength(1);
    expect(capGroups(groups, 3)).toHaveLength(2);
  });
});

describe("copy", () => {
  it("has no catalog problems", () => {
    expect(catalogProblems({ en, fr })).toEqual([]);
  });
});
