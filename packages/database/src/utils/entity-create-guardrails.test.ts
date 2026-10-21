import { describe, expect, it } from "vitest";
import {
  isJunkEntityTitle,
  profileRejectsJunkTitle,
  shouldRejectJunkTitle,
  buildJunkTitleMessage,
  buildWeakEntityDedupMessage,
  buildWeakDedupCause,
  ENTITY_WEAK_DEDUP_CODE,
  WEAK_DEDUP_GUIDANCE,
} from "./entity-create-guardrails.js";

describe("isJunkEntityTitle", () => {
  it("rejects empty / whitespace / null / undefined", () => {
    expect(isJunkEntityTitle(null)).toBe(true);
    expect(isJunkEntityTitle(undefined)).toBe(true);
    expect(isJunkEntityTitle("")).toBe(true);
    expect(isJunkEntityTitle("   ")).toBe(true);
  });

  it("rejects known placeholder names (case-insensitive)", () => {
    expect(isJunkEntityTitle("Not publicly disclosed")).toBe(true);
    expect(isJunkEntityTitle("TEAM NOT PUBLICLY DISCLOSED")).toBe(true);
    expect(isJunkEntityTitle("Team anonymous")).toBe(true);
    expect(isJunkEntityTitle("unknown")).toBe(true);
    expect(isJunkEntityTitle("TBD")).toBe(true);
    expect(isJunkEntityTitle("N/A")).toBe(true);
    expect(isJunkEntityTitle("na")).toBe(true);
  });

  it("accepts real names", () => {
    expect(isJunkEntityTitle("Alice Johnson")).toBe(false);
    expect(isJunkEntityTitle("Acme Corp")).toBe(false);
  });
});

describe("profileRejectsJunkTitle / shouldRejectJunkTitle", () => {
  it("applies to person, company, contact only", () => {
    expect(profileRejectsJunkTitle("person")).toBe(true);
    expect(profileRejectsJunkTitle("company")).toBe(true);
    expect(profileRejectsJunkTitle("contact")).toBe(true);
    expect(profileRejectsJunkTitle("note")).toBe(false);
    expect(profileRejectsJunkTitle("task")).toBe(false);
    expect(profileRejectsJunkTitle(undefined)).toBe(false);
  });

  it("combines profile + title", () => {
    expect(shouldRejectJunkTitle("person", "unknown")).toBe(true);
    expect(shouldRejectJunkTitle("person", "Alice")).toBe(false);
    expect(shouldRejectJunkTitle("note", "unknown")).toBe(false);
    expect(shouldRejectJunkTitle("note", "")).toBe(false);
  });

  it("buildJunkTitleMessage names the profile", () => {
    expect(buildJunkTitleMessage("person")).toMatch(/person/);
    expect(buildJunkTitleMessage("person")).toMatch(/placeholder/i);
  });
});

describe("buildWeakEntityDedupMessage / cause", () => {
  it("lists candidates and names the reviewer's verbs, never forceCreate", () => {
    const msg = buildWeakEntityDedupMessage(
      [{ id: "e1", title: "Alice", type: "person" }],
      "person"
    );
    expect(msg).toMatch(/Alice/);
    expect(msg).toMatch(/e1/);
    expect(msg).not.toMatch(/forceCreate/);
    expect(msg).toMatch(/keep both/);
    expect(msg).toContain(WEAK_DEDUP_GUIDANCE);
  });

  it("buildWeakDedupCause carries stable code + candidates", () => {
    const cause = buildWeakDedupCause([
      { id: "e1", title: "Alice", type: "person" },
    ]);
    expect(cause.code).toBe(ENTITY_WEAK_DEDUP_CODE);
    expect(cause.candidates).toHaveLength(1);
    expect(cause.guidance).toBe(WEAK_DEDUP_GUIDANCE);
  });
});
