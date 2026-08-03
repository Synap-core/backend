import { describe, it, expect } from "vitest";
import {
  AiUsageCollector,
  beginAiUsageCapture,
  withAiUsageCapture,
  recordAiUsage,
  currentAiUsage,
} from "./ai-usage-collector.js";

describe("AiUsageCollector", () => {
  it("reports nothing for a step that made no IS generation", () => {
    const c = new AiUsageCollector();
    expect(c.size).toBe(0);
    expect(c.totals()).toEqual({
      finishReason: null,
      tokensIn: null,
      tokensOut: null,
      tokensTotal: null,
    });
  });

  it("keeps absent usage NULL rather than a fabricated 0", () => {
    // A pre-seam IS build returns only `output` — the call HAPPENED, but no
    // provider numbers came back. Reporting 0 would be a lie.
    const c = new AiUsageCollector();
    c.record({});
    expect(c.size).toBe(1);
    expect(c.totals()).toEqual({
      finishReason: null,
      tokensIn: null,
      tokensOut: null,
      tokensTotal: null,
    });
  });

  it("captures the empty-generation signature: finish=length, 0 out", () => {
    const c = new AiUsageCollector();
    c.record({
      finishReason: "length",
      promptTokens: 4210,
      completionTokens: 0,
    });
    expect(c.totals()).toEqual({
      finishReason: "length",
      tokensIn: 4210,
      tokensOut: 0,
      tokensTotal: 4210,
    });
  });

  it("sums tokens across several calls in one step (loop body / retry)", () => {
    const c = new AiUsageCollector();
    c.record({ finishReason: "stop", promptTokens: 100, completionTokens: 20 });
    c.record({ finishReason: "stop", promptTokens: 300, completionTokens: 50 });
    expect(c.size).toBe(2);
    expect(c.totals()).toMatchObject({
      tokensIn: 400,
      tokensOut: 70,
      tokensTotal: 470,
    });
  });

  it("collapses finish reasons to the DIAGNOSTIC one, not the last one", () => {
    // A step whose second of three calls truncated must report `length` —
    // otherwise the finding is buried by the two boring calls around it.
    const c = new AiUsageCollector();
    c.record({ finishReason: "stop" });
    c.record({ finishReason: "length" });
    c.record({ finishReason: "stop" });
    expect(c.totals().finishReason).toBe("length");
  });

  it("prefers the provider's own total over the derived sum", () => {
    const c = new AiUsageCollector();
    c.record({ promptTokens: 10, completionTokens: 5, totalTokens: 999 });
    expect(c.totals().tokensTotal).toBe(999);
  });

  it("recordAiUsage is a no-op outside a step scope", () => {
    expect(currentAiUsage()).toBeUndefined();
    expect(() => recordAiUsage({ finishReason: "length" })).not.toThrow();
  });

  it("records into the scope's collector when one is open", () => {
    const c = new AiUsageCollector();
    withAiUsageCapture(c, () => {
      recordAiUsage({ finishReason: "content-filter", completionTokens: 0 });
    });
    expect(c.totals()).toMatchObject({
      finishReason: "content-filter",
      tokensOut: 0,
    });
  });

  it("beginAiUsageCapture replaces the previous step's collector", () => {
    withAiUsageCapture(new AiUsageCollector(), () => {
      const first = beginAiUsageCapture();
      recordAiUsage({ promptTokens: 1 });
      const second = beginAiUsageCapture();
      recordAiUsage({ promptTokens: 2 });
      expect(first.totals().tokensIn).toBe(1);
      expect(second.totals().tokensIn).toBe(2);
    });
  });
});
