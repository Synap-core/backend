/**
 * The needs-you push says WHAT is asked: the slot's `why`, else its ask's own
 * prompt — a `confirm` ask may carry its question there and nowhere else.
 * Pure (`summarizeOwedSlots`).
 */
import { describe, it, expect } from "vitest";
import { summarizeOwedSlots } from "../notify-needs-you.js";

describe("summarizeOwedSlots", () => {
  it("says the why when there is one", () => {
    expect(
      summarizeOwedSlots([
        {
          kind: "k",
          label: "Stripe key",
          why: "Which account?",
          ask: { mode: "confirm", prompt: "Use EU?" },
        },
      ])
    ).toBe("Stripe key — Which account?");
  });

  it("falls back to the ask's prompt when the slot has no why", () => {
    expect(
      summarizeOwedSlots([
        {
          kind: "k",
          label: "Ship",
          ask: { mode: "confirm", prompt: "Ship today?" },
        },
        { kind: "k", label: "Other" },
      ])
    ).toBe("Ship — Ship today? (+1 more)");
  });

  it("is the label alone when nothing says what is asked", () => {
    expect(summarizeOwedSlots([{ kind: "k", label: "Ship" }])).toBe("Ship");
  });
});
