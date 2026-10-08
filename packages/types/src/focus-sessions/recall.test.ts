import { describe, it, expect } from "vitest";
import { projectSessionRecall } from "./recall.js";

const item = {
  entityId: "e",
  title: "Strobe",
  kind: "track",
  score: 0.5,
  reason: "r",
  recalledAt: "t",
};

describe("projectSessionRecall — five states, never folded", () => {
  it("pending / ok / empty", () => {
    expect(projectSessionRecall(null)).toEqual({ status: "pending" });
    expect(projectSessionRecall({})).toEqual({ status: "pending" });
    expect(projectSessionRecall({ recalledAt: "t", recalled: [] })).toEqual({
      status: "empty",
      recalledAt: "t",
    });
    expect(projectSessionRecall({ recalledAt: "t", recalled: [item] })).toEqual(
      {
        status: "ok",
        recalled: [item],
        recalledAt: "t",
      }
    );
  });

  it("a FAILED recall is never empty, and keeps what an earlier run found", () => {
    expect(
      projectSessionRecall({
        recalledAt: "t",
        recalled: [item],
        recallError: { message: "down" },
      })
    ).toEqual({
      status: "failed",
      error: "down",
      recalledAt: "t",
      recalled: [item],
    });
    // An error with no recalledAt has not finished a run: pending, as the pod reads it.
    expect(projectSessionRecall({ recallError: { message: "x" } })).toEqual({
      status: "pending",
    });
  });

  it("a SKIPPED recall names why, and is not empty", () => {
    expect(
      projectSessionRecall({
        recalledAt: "t",
        recalled: [],
        recallSkipped: "automation",
      })
    ).toEqual({ status: "skipped", reason: "automation", recalledAt: "t" });
    // An unknown skip reason is not trusted: the list decides.
    expect(
      projectSessionRecall({
        recalledAt: "t",
        recalled: [],
        recallSkipped: "whim",
      })
    ).toEqual({ status: "empty", recalledAt: "t" });
  });

  it("drops malformed stored items instead of passing them on", () => {
    expect(
      projectSessionRecall({
        recalledAt: "t",
        recalled: [item, { title: 1 }, null],
      })
    ).toEqual({ status: "ok", recalled: [item], recalledAt: "t" });
  });
});
