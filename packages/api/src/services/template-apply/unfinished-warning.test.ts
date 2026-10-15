/**
 * `unfinishedWarning` — the sentence an unfinished apply answers. A FAILED
 * read of the space's warning is never folded into "nothing to say": that is
 * the answer only for a READ that found every proposal decided (review2 Q6 —
 * the desktop toasted "updated" for an apply still waiting on approval).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** What the space's warning read answers; an Error = the read throws. */
const h = vi.hoisted(() => ({ read: null as string | null | Error }));
vi.mock("../template-health.js", () => ({
  templateApplyWarningFor: async () => {
    if (h.read instanceof Error) throw h.read;
    return h.read;
  },
}));

import { unfinishedWarning } from "./index.js";

beforeEach(() => {
  h.read = null;
});

describe("unfinishedWarning", () => {
  it("awaiting approval, the read FAILS → a fixed sentence, never null", async () => {
    h.read = new Error("connection reset");
    expect(
      await unfinishedWarning("ws-1", { state: "awaiting-approval" }, "crm")
    ).toBe("Waiting for approval of the proposals this update filed.");
  });

  it("awaiting approval, the read finds every proposal decided → null", async () => {
    expect(
      await unfinishedWarning("ws-1", { state: "awaiting-approval" }, "crm")
    ).toBeNull();
  });

  it("the space's own sentence wins when it reads", async () => {
    h.read = "Waiting on your approval of 1 proposal (p-1).";
    expect(
      await unfinishedWarning("ws-1", { state: "awaiting-approval" }, "crm")
    ).toBe("Waiting on your approval of 1 proposal (p-1).");
  });

  it("any other unfinished state, the read fails → the fixed 'finish it' sentence", async () => {
    h.read = new Error("connection reset");
    expect(await unfinishedWarning("ws-1", { state: "partial" }, "crm")).toBe(
      "Not finished: run `synap templates update crm` to finish crm."
    );
  });
});
