/**
 * The degraded salvage must reach the AGENT doors, and the message must be
 * DERIVED from the reason — never a hardcoded "temporarily unavailable".
 *
 * Two halves, mirroring the door-parity tripwire's own structure:
 *  - the DECISION: which permanence class a reason falls into, and that an
 *    unknown reason is never guessed into `transient`.
 *  - the WIRE: that both agent doors actually forward the salvage. Both live
 *    inside procedures that cannot be invoked without the whole IS + DB world,
 *    so those are source scans — the same technique, and for the same reason,
 *    as `capture-receipt-honesty.test.ts`'s STATUS_DOORS scan.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildDegradedNextStep,
  classifyDegradedReason,
  describeDegradedForAgent,
  isDegradedReasonRetryable,
} from "./capture-degraded-guidance.js";

const API_SRC = join(__dirname, "..", "..");

describe("degraded reason → permanence class", () => {
  it.each([
    "vision_provider_not_configured",
    "transcription_provider_not_configured",
    "is_auth_error",
  ])("%s is a CONFIGURATION state, not an outage", (reason) => {
    expect(classifyDegradedReason(reason)).toBe("configuration");
    expect(isDegradedReasonRetryable(reason)).toBe(false);
  });

  it.each([
    "pdf_scanned_needs_ocr",
    "pdf_missing_binary",
    "image_missing_binary",
    "audio_missing_binary",
    "docx_missing_binary",
    "docx_empty",
    "html_empty",
    "unsupported_type",
  ])("%s is an INPUT state — retrying the same bytes cannot help", (reason) => {
    expect(classifyDegradedReason(reason)).toBe("input");
    expect(isDegradedReasonRetryable(reason)).toBe(false);
  });

  it("is_invalid_response is the one genuinely transient reason", () => {
    expect(classifyDegradedReason("is_invalid_response")).toBe("transient");
    expect(isDegradedReasonRetryable("is_invalid_response")).toBe(true);
  });

  it.each(["llm_budget_exceeded", "extraction_error: BudgetExceededError"])(
    "%s is a BUDGET state — not retryable now, but not unknown/permanent",
    (reason) => {
      expect(classifyDegradedReason(reason)).toBe("budget");
      expect(isDegradedReasonRetryable(reason)).toBe(false);
      const msg = describeDegradedForAgent(reason);
      expect(msg).toContain(reason);
      expect(msg).toMatch(/monthly LLM token budget/);
      expect(msg).toMatch(/NOT permanent/);
      expect(msg).not.toMatch(/did not say why/);
      expect(msg.toLowerCase()).not.toContain("temporar");
    }
  );

  it("an unrelated extraction_error is still UNKNOWN (the budget match is exact)", () => {
    expect(classifyDegradedReason("extraction_error: TypeError")).toBe(
      "unknown"
    );
  });

  it("is_empty_result is UNKNOWN, never transient", () => {
    // `is_empty_result` is the pod's last-resort "we don't know why" label.
    // Classifying it transient is precisely the defect: it tells a caller to
    // retry a state that may be permanent.
    expect(classifyDegradedReason("is_empty_result")).toBe("unknown");
    expect(isDegradedReasonRetryable("is_empty_result")).toBe(false);
  });

  it("a reason the pod has never been taught degrades to unknown, not transient", () => {
    // The IS owns this vocabulary and may extend it at any time.
    expect(classifyDegradedReason("ocr_budget_exhausted")).toBe("unknown");
    expect(isDegradedReasonRetryable("ocr_budget_exhausted")).toBe(false);
  });

  it.each([undefined, null, "", "   "])(
    "treats %p as unknown rather than inventing a cause",
    (reason) => {
      expect(classifyDegradedReason(reason)).toBe("unknown");
    }
  );
});

describe("the agent-facing message is DERIVED, not hardcoded", () => {
  it("never calls a permanent configuration state temporary", () => {
    const msg = describeDegradedForAgent("vision_provider_not_configured");
    expect(msg).toContain("vision_provider_not_configured");
    expect(msg).toMatch(/CONFIGURATION state, not an outage/);
    expect(msg.toLowerCase()).not.toContain("temporar");
    expect(msg.toLowerCase()).not.toContain("try again later");
  });

  it("never calls an UNKNOWN reason temporary either", () => {
    const msg = describeDegradedForAgent("ocr_budget_exhausted");
    expect(msg).toContain("ocr_budget_exhausted");
    expect(msg).toMatch(/[Dd]o not assume this is temporary/);
  });

  it("says transient only for the reason that earns it", () => {
    expect(describeDegradedForAgent("is_invalid_response")).toContain(
      "transient"
    );
  });

  it.each([
    "vision_provider_not_configured",
    "is_empty_result",
    "unsupported_type",
    "is_invalid_response",
    undefined,
  ])("echoes a usable token and never leaks undefined (%p)", (reason) => {
    const msg = describeDegradedForAgent(reason);
    expect(msg).not.toContain("undefined");
    expect(msg.length).toBeGreaterThan(20);
  });

  it("names the ONE governed door and does not invent a second write path", () => {
    const step = buildDegradedNextStep("salvagedEntities");
    expect(step).toContain("salvagedEntities");
    // The write stays the caller re-entering through the governed door with an
    // explicit plan — see __tripwires__/capture-graph-governance-linkage.
    expect(step).toMatch(/synap_capture|\/capture\/execute/);
    // And it must not claim a write happened.
    expect(step).toContain("nothing was written");
  });
});

describe("the WIRE: both agent doors forward the salvage", () => {
  it("Hub REST /capture/structure answers the degraded branch", () => {
    const source = readFileSync(
      join(API_SRC, "routers", "hub-protocol", "rest", "capture.ts"),
      "utf8"
    );
    // The branch must exist, carry a caller-state word, and hand back both the
    // derived message and the salvaged note. Before this change the door fell
    // straight through to a bare `c.json(result)` with neither.
    expect(source).toMatch(/degraded\s*\)?\s*===\s*true/);
    expect(source).toContain('status: "not_structured"');
    expect(source).toContain("describeDegradedForAgent(");
    expect(source).toContain("salvagedEntities");
    expect(source).toContain("buildDegradedNextStep(");
  });

  it("message.interpret returns the note instead of discarding it", () => {
    const source = readFileSync(
      join(API_SRC, "services", "capabilities", "builtin-verbs.ts"),
      "utf8"
    );
    expect(source).toContain("describeDegradedForAgent(");
    expect(source).toContain("buildDegradedNextStep(");
    // EMISSION, not mention. A bare `toContain("salvagedEntities")` passes on a
    // file that merely DECLARES the local const and never puts it on the
    // returned object — a renamed key (`salvagedEntitiesXX: salvagedEntities`)
    // survived exactly that guard on the first mutation pass. Assert the
    // shorthand property as it is actually returned.
    expect(source).toMatch(/\n\s*salvagedEntities,\n/);
  });

  it("the REST 200 codec DECLARES the new fields", () => {
    // `.passthrough()` would let them ride through undeclared — published
    // nowhere and promised to nobody, which is exactly how the honesty triple
    // was lost on this door in the first place.
    const source = readFileSync(
      join(API_SRC, "routers", "hub-protocol", "rest", "_codecs", "misc.ts"),
      "utf8"
    );
    const start = source.indexOf("export const CaptureStructureResponseSchema");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('.openapi("CaptureStructureResponse")', start);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    for (const field of [
      "status",
      "degradedMessage",
      "degradedRetryable",
      "salvagedEntities",
      "nextStep",
    ]) {
      expect(block).toContain(`${field}:`);
    }
  });
});
