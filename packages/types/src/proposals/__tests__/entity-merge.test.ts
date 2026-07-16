import { describe, it, expect } from "vitest";
import {
  isEntityMergeProposalData,
  type EntityMergeProposalData,
} from "../index.js";

describe("isEntityMergeProposalData", () => {
  const valid: EntityMergeProposalData = {
    winnerId: "11111111-2222-3333-4444-555555555555",
    loserId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    confidence: 0.97,
    method: "strong_signal",
    signalsMatched: ["email:a@b.com"],
    propertyPlan: {
      filled: ["phone"],
      conflicts: [
        { key: "title", winnerValue: "Ada", loserValue: "A. Lovelace" },
      ],
    },
  };

  it("accepts a well-formed merge payload", () => {
    expect(isEntityMergeProposalData(valid)).toBe(true);
  });

  it("accepts every known method", () => {
    for (const method of [
      "strong_signal",
      "exact_title",
      "embedding",
      "manual",
    ] as const) {
      expect(isEntityMergeProposalData({ ...valid, method })).toBe(true);
    }
  });

  it("rejects missing winner/loser/confidence/method", () => {
    expect(isEntityMergeProposalData({ ...valid, winnerId: "" })).toBe(false);
    expect(
      isEntityMergeProposalData({
        loserId: valid.loserId,
        confidence: 1,
        method: "manual",
      })
    ).toBe(false);
    expect(
      isEntityMergeProposalData({
        winnerId: valid.winnerId,
        loserId: valid.loserId,
        method: "manual",
      })
    ).toBe(false);
    expect(
      isEntityMergeProposalData({
        winnerId: valid.winnerId,
        loserId: valid.loserId,
        confidence: 1,
        method: "unknown",
      })
    ).toBe(false);
  });

  it("rejects composite / document / null shapes", () => {
    expect(isEntityMergeProposalData(null)).toBe(false);
    expect(isEntityMergeProposalData(undefined)).toBe(false);
    expect(
      isEntityMergeProposalData({
        operations: [{ op: "create_entity", profileSlug: "note" }],
      })
    ).toBe(false);
    expect(isEntityMergeProposalData({ proposedContent: "hello" })).toBe(false);
  });
});
