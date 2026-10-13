/**
 * Labels, tones and schema-less type detection — ported with the app-bases
 * tests (`fieldFormatters.label.test.ts`, `statusSemantics.decision-states
 * .test.ts`); the web-token assertions (`statusSemantics.tokens.test.ts`) stay
 * with the tokens in app-bases.
 */

import { describe, expect, it } from "vitest";
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
    expect(getEnumUnitTone("rejected")).toBe("error");
    expect(getEnumUnitTone("whatever")).toBe("textMuted");
  });

  it("priority defaults to medium", () => {
    expect(getPriorityLevel("Critical")).toBe("urgent");
    expect(getPriorityLevel("nope")).toBe("medium");
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
