/**
 * Labels, tones and schema-less type detection — ported with the app-bases
 * tests (`fieldFormatters.label.test.ts`, `statusSemantics.decision-states
 * .test.ts`); the web-token assertions (`statusSemantics.tokens.test.ts`) stay
 * with the tokens in app-bases.
 */

import { describe, expect, it } from "vitest";
import {
  resolveStatusTone,
  STATUS_TONE,
  type UnitTone,
} from "../units/state.js";
import { humanizeToken } from "../vocabulary/index.js";
import {
  detectFieldType,
  formatFieldLabel,
  formatFieldValue,
  getEnumTone,
  getEnumUnitTone,
  getPriorityLevel,
  resolvePropertyLabel,
} from "./index.js";

/**
 * ONE casing for a property label: the slug fallback is the vocabulary's
 * `humanizeToken` (sentence case), not a local Title Case. The rows below are
 * the ones where the two rules DISAGREE — a single-word slug would pass under
 * both and prove nothing.
 */
const MULTI_WORD = [
  "first_name",
  "linkedinUrl",
  "deal-stage",
  "annual_revenue",
  "metadata.lastContactedAt",
];

describe("property label casing — one door", () => {
  it.each(MULTI_WORD)("%s humanizes exactly like the vocabulary", (slug) => {
    const expected = humanizeToken(slug.replace(/^metadata\./, ""));
    expect(formatFieldLabel(slug)).toBe(expected);
    expect(resolvePropertyLabel({ slug })).toBe(expected);
  });

  it("is sentence case, not Title Case", () => {
    expect(resolvePropertyLabel({ slug: "first_name" })).toBe("First name");
    expect(formatFieldLabel("annualRevenue")).toBe("Annual revenue");
  });

  it("an authored label wins verbatim; displayName beats label", () => {
    expect(
      resolvePropertyLabel({ slug: "mrr", uiHints: { label: "MRR" } })
    ).toBe("MRR");
    expect(
      resolvePropertyLabel({
        slug: "mrr",
        uiHints: { displayName: "Monthly revenue", label: "MRR" },
      })
    ).toBe("Monthly revenue");
  });

  it("a non-string or blank authored label falls through to the slug", () => {
    expect(
      resolvePropertyLabel({ slug: "due_on", uiHints: { label: 42 } })
    ).toBe("Due on");
    expect(
      resolvePropertyLabel({ slug: "due_on", uiHints: { label: "  " } })
    ).toBe("Due on");
  });

  it("a dotted slug keeps its whole path, so sibling paths stay distinct", () => {
    expect(formatFieldLabel("billing.city")).toBe("Billing city");
    expect(formatFieldLabel("shipping.city")).toBe("Shipping city");
    expect(formatFieldLabel("metadata.billing.city")).toBe("Billing city");
  });

  it("the curated special cases still apply", () => {
    expect(formatFieldLabel("userId")).toBe("User ID");
    expect(formatFieldLabel("createdAt")).toBe("Created");
  });
});

describe("enum tone", () => {
  it.each([
    ["accepted", "positive"],
    ["Accepted", "positive"],
    ["proposed", "pending"],
    ["In Progress", "active"],
    ["failed", "negative"],
    ["something-custom", "neutral"],
  ])("%s → %s", (value, tone) => {
    expect(getEnumTone(value)).toBe(tone);
  });

  it("names a cross-surface palette tone, never a colour", () => {
    expect(getEnumUnitTone("done")).toBe("success");
    expect(getEnumUnitTone("failed")).toBe("error");
    expect(getEnumUnitTone("whatever")).toBe("textMuted");
  });

  /**
   * The tone comes from THE status tone table (`resolveStatusTone`,
   * `../units`), never a table of this module's own. The five unit tones an
   * enum bucket names pass through unchanged; the three it has no bucket for
   * fold onto the nearest one.
   */
  const FOLD: Record<UnitTone, UnitTone> = {
    success: "success",
    error: "error",
    primary: "primary",
    info: "info",
    textMuted: "textMuted",
    warning: "info",
    ai: "textMuted",
    textSecondary: "textMuted",
  };

  it("every word of the status tone table paints the tone resolveStatusTone gives it", () => {
    const words = Object.keys(STATUS_TONE);
    expect(words.length).toBeGreaterThan(40);
    for (const word of words) {
      expect(getEnumUnitTone(word), word).toBe(FOLD[resolveStatusTone(word)]);
    }
  });

  it("reads the words the old private table painted red or pending as calm", () => {
    // `ENUM_TONE_MAP` (removed) said negative / pending; the units table says muted.
    for (const word of ["rejected", "cancelled", "canceled", "draft"]) {
      expect(resolveStatusTone(word)).toBe("textMuted");
      expect(getEnumTone(word), word).toBe("neutral");
      expect(getEnumUnitTone(word), word).toBe("textMuted");
    }
  });

  it("priority defaults to medium", () => {
    expect(getPriorityLevel("Critical")).toBe("urgent");
    expect(getPriorityLevel(" High ")).toBe("high");
    expect(getPriorityLevel("nope")).toBe("medium");
    // A stored priority may not be a string at runtime.
    expect(getPriorityLevel(3)).toBe("medium");
  });
});

describe("schema-less field type", () => {
  it.each([
    ["2026-10-12", "date"],
    ["2026-10-12T08:00:00Z", "datetime"],
    ["ada@example.com", "email"],
    ["https://synap.live", "url"],
    ["", "empty"],
    ["hello", "text"],
  ] as const)("%s → %s", (value, type) => {
    expect(detectFieldType(value)).toBe(type);
  });

  it("formats lists and booleans for a one-line cell", () => {
    expect(formatFieldValue(["a", "b"], "array")).toBe("a, b");
    expect(formatFieldValue(true, "boolean")).toBe("Yes");
  });
});
