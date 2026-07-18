import { describe, expect, it } from "vitest";
import {
  normalizeProjectName,
  tokenSetOverlap,
  classifyProjectMatch,
  assessEvidenceGravity,
  buildProjectProvenance,
  MIN_EVIDENCE_ENTITIES,
  type ExistingProjectRef,
} from "./project-guardrails.js";

describe("normalizeProjectName", () => {
  it("lowercases, strips punctuation, drops stopwords, collapses whitespace", () => {
    expect(normalizeProjectName("The Synap Project!")).toBe("synap");
    expect(normalizeProjectName("  Acme   CRM  ")).toBe("acme crm");
    expect(normalizeProjectName("Q2-2024 / Launch")).toBe("q2 2024 launch");
  });

  it("collapses to empty when only stopwords/punctuation remain", () => {
    expect(normalizeProjectName("The Project")).toBe("");
    expect(normalizeProjectName("!!!")).toBe("");
  });
});

describe("tokenSetOverlap", () => {
  it("is 1 for the same token set regardless of order/case", () => {
    expect(tokenSetOverlap("Acme CRM Rollout", "rollout acme crm")).toBe(1);
  });

  it("is 0 for fully disjoint names", () => {
    expect(tokenSetOverlap("alpha beta", "gamma delta")).toBe(0);
  });

  it("computes Jaccard for partial overlap", () => {
    // {a,b,g,d} vs {a,b,g,d,e} → 4 / 5 = 0.8
    expect(
      tokenSetOverlap(
        "alpha beta gamma delta",
        "alpha beta gamma delta epsilon"
      )
    ).toBeCloseTo(0.8);
  });
});

describe("classifyProjectMatch", () => {
  const existing: ExistingProjectRef[] = [
    { id: "p-exact", name: "The Synap Project", status: "active" },
    {
      id: "p-near",
      name: "alpha beta gamma delta epsilon",
      status: "active",
    },
    { id: "p-other", name: "Completely Different Thing", status: "active" },
  ];

  it("finds an exact-normalized match (ignoring case/stopwords/punctuation)", () => {
    const res = classifyProjectMatch("synap!", existing);
    expect(res.exact?.id).toBe("p-exact");
  });

  it("returns near candidates (overlap ≥ 0.8) sorted best-first, no exact", () => {
    const res = classifyProjectMatch("alpha beta gamma delta", existing);
    expect(res.exact).toBeNull();
    expect(res.near.map((c) => c.id)).toContain("p-near");
    expect(res.near[0]!.score).toBeGreaterThanOrEqual(0.8);
  });

  it("returns no matches for an unrelated name", () => {
    const res = classifyProjectMatch("Zephyr Onboarding Flow", existing);
    expect(res.exact).toBeNull();
    expect(res.near).toHaveLength(0);
  });
});

describe("assessEvidenceGravity", () => {
  it("rejects when fewer than the minimum entities are visible", () => {
    const res = assessEvidenceGravity({
      providedCount: 2,
      visibleCount: 2,
      near: [],
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain(`≥${MIN_EVIDENCE_ENTITIES}`);
    expect(res.message).toContain("commitment with gravity");
  });

  it("passes when at least the minimum entities are visible", () => {
    const res = assessEvidenceGravity({
      providedCount: 5,
      visibleCount: 5,
      near: [],
    });
    expect(res.ok).toBe(true);
    expect(res.message).toBeUndefined();
  });

  it("counts only visible ids, not the provided count, and names candidates", () => {
    const res = assessEvidenceGravity({
      providedCount: 6,
      visibleCount: 3,
      near: [{ id: "p-1", name: "Existing Thing", score: 0.9 }],
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("Existing Thing (p-1)");
  });
});

describe("buildProjectProvenance", () => {
  it("marks human creators and omits agent fields", () => {
    const p = buildProjectProvenance({ door: "trpc" });
    expect(p.createdByKind).toBe("human");
    expect(p.agentUserId).toBeUndefined();
    expect(p.evidenceEntityIds).toBeUndefined();
    expect(typeof p.createdAtIso).toBe("string");
  });

  it("marks agent creators and carries evidence", () => {
    const p = buildProjectProvenance({
      door: "mcp",
      agentUserId: "agent-1",
      evidenceEntityIds: ["e1", "e2"],
    });
    expect(p.createdByKind).toBe("agent");
    expect(p.door).toBe("mcp");
    expect(p.agentUserId).toBe("agent-1");
    expect(p.evidenceEntityIds).toEqual(["e1", "e2"]);
  });
});
