/**
 * `deriveCaptureStatus` — each row names the WRONG rule it rules out, so the
 * table covers the inputs where plausible orderings disagree (not merely the
 * inputs that look representative).
 */

import { describe, it, expect } from "vitest";
import { deriveCaptureStatus } from "./derive-capture-status.js";

const rows: Array<{
  name: string;
  facts: Parameters<typeof deriveCaptureStatus>[0];
  want: ReturnType<typeof deriveCaptureStatus>;
  rulesOut: string;
}> = [
  {
    name: "degraded + produced > 0 ⇒ structured",
    facts: { hasOpenQuestion: false, degraded: true, producedCount: 2 },
    want: "structured",
    rulesOut: "degraded checked before produced",
  },
  {
    name: "degraded + nothing produced ⇒ saved_without_ai",
    facts: { hasOpenQuestion: false, degraded: true, producedCount: 0 },
    want: "saved_without_ai",
    rulesOut: "degraded marker ignored",
  },
  {
    name: "open question beats degraded",
    facts: { hasOpenQuestion: true, degraded: true, producedCount: 0 },
    want: "needs_answer",
    rulesOut: "degraded checked before the open question",
  },
  {
    name: "open question beats produced",
    facts: { hasOpenQuestion: true, degraded: false, producedCount: 3 },
    want: "needs_answer",
    rulesOut: "produced checked before the open question",
  },
  {
    name: "not degraded + nothing produced ⇒ not_structured",
    facts: { hasOpenQuestion: false, degraded: false, producedCount: 0 },
    want: "not_structured",
    rulesOut: "a non-degraded empty source read as saved_without_ai",
  },
];

describe("deriveCaptureStatus", () => {
  it.each(rows)("$name (rules out: $rulesOut)", ({ facts, want }) => {
    expect(deriveCaptureStatus(facts)).toBe(want);
  });
});
