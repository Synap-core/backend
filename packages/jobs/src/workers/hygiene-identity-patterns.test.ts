import { describe, it, expect } from "vitest";
import {
  isSentinelTitle,
  findPropertyKeyAliasHits,
  classifyIdentityHygieneEntity,
  normalizePropertyKey,
} from "./hygiene-identity-patterns.js";

describe("hygiene-identity-patterns (H0)", () => {
  it("detects sentinel titles", () => {
    expect(isSentinelTitle("Not publicly disclosed")).toBe(true);
    expect(isSentinelTitle("Team not publicly disclosed")).toBe(true);
    expect(isSentinelTitle("  TBD  ")).toBe(true);
    expect(isSentinelTitle("")).toBe(true);
    expect(isSentinelTitle("Pretium")).toBe(false);
  });

  it("finds property key aliases", () => {
    const hits = findPropertyKeyAliasHits({
      "LinkedIn URL": "https://linkedin.com/in/x",
      email: "a@b.com",
    });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.orphanKey === "LinkedIn URL")).toBe(true);
    expect(
      hits.find((h) => h.orphanKey === "LinkedIn URL")?.canonicalKey
    ).toMatch(/linkedin/i);
  });

  it("classify: sentinel + rich props", () => {
    const r = classifyIdentityHygieneEntity({
      id: "e1",
      title: "Not publicly disclosed",
      type: "person",
      properties: {
        website: "https://example.com",
        "LinkedIn URL": "https://linkedin.com/in/x",
      },
    });
    expect(r.isSentinel).toBe(true);
    expect(r.isRich).toBe(true);
    expect(r.hit?.propertyAliasHits.length).toBeGreaterThan(0);
  });

  it("normalizePropertyKey collapses punctuation", () => {
    expect(normalizePropertyKey("LinkedIn URL")).toBe("linkedinurl");
    expect(normalizePropertyKey("linkedin_url")).toBe("linkedinurl");
  });
});
