/**
 * Regression: the synthesis context must never exceed the limit the IS route
 * actually accepts.
 *
 * Live defect (team pod, 2026-08-19): `POST /api/hub/knowledge/answer`
 * {"query":"list our clients", limit:5} returned answer:null,
 * error:"synthesis_unavailable", failure.code:"bad_request", retryable:false —
 * with 34 sources. The IS validates `context: z.string().max(20000)`; this
 * builder budgeted 40_000, produced a 29,670-char context, and zod 400'd it.
 * The same pod answered fine at 8 sources. Size was the only variable.
 */
import { describe, it, expect } from "vitest";
import { buildSynthesisContext } from "../synthesize.js";
import type { AskAnswer } from "../ask.js";

/** The literal cap in intelligence-hub/src/routes/knowledge-answer.ts. */
const IS_CONTEXT_MAX = 20000;

function manyEntities(count: number, bodyChars: number): AskAnswer[] {
  return [
    {
      substrate: "structured",
      status: "ok",
      items: Array.from({ length: count }, (_, i) => ({
        id: `e${i}`,
        title: `Entity ${i}`,
        content: "z".repeat(bodyChars),
      })),
    },
  ] as unknown as AskAnswer[];
}

describe("buildSynthesisContext — IS payload contract", () => {
  it("never builds a context the IS would reject with a 400", () => {
    const { context } = buildSynthesisContext(manyEntities(200, 1500));
    expect(context.length).toBeLessThanOrEqual(IS_CONTEXT_MAX);
  });

  it("reproduces the live shape (34 sources) under the cap", () => {
    const { context, sources } = buildSynthesisContext(manyEntities(34, 1200));
    expect(sources).toHaveLength(34);
    expect(context.length).toBeLessThanOrEqual(IS_CONTEXT_MAX);
  });

  it("declares the shortfall instead of silently truncating the list", () => {
    const { context } = buildSynthesisContext(manyEntities(200, 1500));
    expect(context).toContain("CONTEXT TRUNCATED");
    // The count must be real, not a boolean dressed as a number.
    const m = /CONTEXT TRUNCATED: (\d+) of (\d+) retrieved/.exec(context);
    expect(m).not.toBeNull();
    const [, omitted, total] = m!;
    expect(Number(total)).toBe(200);
    expect(Number(omitted)).toBeGreaterThan(0);
    expect(Number(omitted)).toBeLessThan(200);
  });

  it("adds no notice when everything fits", () => {
    const { context } = buildSynthesisContext(manyEntities(3, 100));
    expect(context).not.toContain("CONTEXT TRUNCATED");
  });

  it("still lists every match as a source even when the context is cut", () => {
    const { sources } = buildSynthesisContext(manyEntities(200, 1500));
    expect(sources).toHaveLength(200);
  });
});
