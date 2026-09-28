import { describe, expect, it } from "vitest";
import { failingFlowOfGroup } from "./global.js";

/**
 * The rail's health mark opens Work › Activity › Failed, headed by the failing
 * FLOWS — each a door to its own page. The door needs the flow's address, and
 * this projection is the one place it can be dropped. Driven from a RunGroup-
 * shaped row, so deleting either address line goes red here.
 */
describe("failingFlowOfGroup", () => {
  it("carries the windowed count AND the flow's address", () => {
    expect(
      failingFlowOfGroup({
        flowName: "New Contact Enrichment",
        recentFailedCount: 12,
        hasRunning: false,
        flowType: "automation",
        flowId: "auto-1",
      })
    ).toEqual({
      flowName: "New Contact Enrichment",
      failedCount: 12,
      hasRunning: false,
      flowType: "automation",
      flowId: "auto-1",
    });
  });
});
