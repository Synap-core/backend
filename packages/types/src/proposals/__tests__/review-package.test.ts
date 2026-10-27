/**
 * reviewPackageOf — the decision each review item asks (founder B-1, 27 Oct).
 * Coverage over every governed door is the tripwire in
 * `@synap/governance-policy` (`review-package-coverage.tripwire.test.ts`);
 * this file pins the behaviours a reader relies on.
 */
import { describe, expect, it } from "vitest";
import {
  REVIEW_PACKAGES,
  REVIEW_PACKAGE_LAYOUTS,
  defaultReviewLayout,
  reviewGroupByFor,
  reviewLayoutFor,
  reviewPackageDecision,
  reviewPackageOf,
} from "../review-package.js";
import { UIPreferencesSchema } from "../../preferences/schemas.js";

const p = (proposalType: string, targetType: string, extra = {}) =>
  reviewPackageOf({ kind: "proposal-cluster", proposalType, targetType, ...extra });

describe("reviewPackageOf — the 27 Oct pending mix", () => {
  it("an agent's update of a session is bookkeeping", () => {
    expect(p("update", "focus_session")).toBe("bookkeeping");
  });
  it("the same update filed by a person is a change to their data", () => {
    expect(p("update", "focus_session", { filedByPerson: true })).toBe(
      "data-changes"
    );
  });
  it("assign_agent is a hand-off, on a session or a goal", () => {
    expect(p("assign_agent", "focus_session")).toBe("hand-offs");
    expect(p("assign_agent", "track")).toBe("hand-offs");
  });
  it("graph imports, captures and knowledge creates are knowledge", () => {
    expect(p("import.graph", "entity")).toBe("knowledge");
    expect(p("capture.graph", "entity")).toBe("knowledge");
    expect(p("create", "entity", { objectKind: "decision" })).toBe("knowledge");
    // CONTROL: a person record is data, not knowledge.
    expect(p("create", "entity", { objectKind: "person" })).toBe(
      "data-changes"
    );
  });
  it("skill, rule, playbook, automation and governance edits are how things work", () => {
    expect(p("update", "skill")).toBe("how-things-work");
    expect(p("update", "playbook")).toBe("how-things-work");
    expect(p("update", "automation")).toBe("how-things-work");
    expect(p("governance.widen_lane", "governance")).toBe("how-things-work");
  });
  it("a deploy approval is a release", () => {
    expect(p("dev.deploy_approval", "focus_session")).toBe("releases");
  });
  it("vault, grants and installs are access; so is anything the pod classes access", () => {
    expect(p("vault.request", "vault")).toBe("access");
    expect(p("capability.install", "capability")).toBe("access");
    expect(p("join", "workspace")).toBe("access");
    expect(p("anything", "elsewhere", { class: "access" })).toBe("access");
  });
  it("a section edit and a new link are changes to the person's data", () => {
    expect(p("section_update", "document")).toBe("data-changes");
    expect(p("create", "relation")).toBe("data-changes");
  });
});

describe("needs-you rows that are not proposals", () => {
  it("owed slots, drafts and captures are questions", () => {
    for (const kind of ["owed-slot", "draft-asks", "capture", "session-review"])
      expect(reviewPackageOf({ kind })).toBe("questions");
  });
  it("access requests and space invites are access", () => {
    expect(reviewPackageOf({ kind: "access-request" })).toBe("access");
    expect(reviewPackageOf({ kind: "space-invite" })).toBe("access");
  });
});

describe("a held-writes pack files by its writes", () => {
  const write = (subjectType: string, action: string, data = {}) => ({
    ref: `${subjectType}-${action}`,
    subjectType,
    action,
    data,
    sessionId: null,
    agentUserId: "a",
    userId: "u",
    at: "2026-10-27T00:00:00Z",
    fingerprint: "f",
  });
  const pack = (writes: unknown[]) =>
    reviewPackageOf({
      proposalType: "held_writes",
      targetType: "agent",
      data: { deferredWrites: writes },
    });

  it("a pack of session notes is bookkeeping", () => {
    expect(
      pack([write("focus_session", "update"), write("focus_session", "create")])
    ).toBe("bookkeeping");
  });
  it("the highest-stakes write decides: one knowledge capture lifts it out of bookkeeping", () => {
    expect(
      pack([
        write("focus_session", "update"),
        write("entity", "create", { profileSlug: "knowledge" }),
      ])
    ).toBe("knowledge");
  });
  it("an unreadable pack is a data change, never quietly bookkeeping", () => {
    expect(pack([])).toBe("data-changes");
    expect(pack([{ nope: true }, write("focus_session", "update")])).toBe(
      "data-changes"
    );
  });
});

describe("an untaught pair still files, and says so", () => {
  it("falls back to data changes with rule `fallback`", () => {
    expect(
      reviewPackageDecision({ proposalType: "teleport", targetType: "moon" })
    ).toEqual({ package: "data-changes", rule: "fallback" });
  });
});

describe("layouts and the saved preference", () => {
  it("every package offers list, and its default first", () => {
    for (const pkg of REVIEW_PACKAGES) {
      expect(REVIEW_PACKAGE_LAYOUTS[pkg]).toContain("list");
      expect(defaultReviewLayout(pkg)).toBe(REVIEW_PACKAGE_LAYOUTS[pkg][0]);
    }
  });
  it("a saved layout the package does not offer is ignored", () => {
    expect(reviewLayoutFor("knowledge", { layouts: { knowledge: "list" } })).toBe(
      "list"
    );
    expect(reviewLayoutFor("access", { layouts: { access: "gallery" } })).toBe(
      "list"
    );
    expect(reviewLayoutFor("knowledge", null)).toBe("gallery");
  });
  it("no saved grouping opens by package", () => {
    expect(reviewGroupByFor(null)).toBe("package");
    expect(reviewGroupByFor({ groupBy: "work" })).toBe("work");
  });
  it("the uiPreferences schema KEEPS `review` (it drops unknown keys)", () => {
    const parsed = UIPreferencesSchema.parse({
      review: { groupBy: "agent", layouts: { knowledge: "list" } },
    });
    expect(parsed?.review).toEqual({
      groupBy: "agent",
      layouts: { knowledge: "list" },
    });
  });
});
