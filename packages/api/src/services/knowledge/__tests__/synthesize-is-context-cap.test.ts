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

  it("names the omitted items in the truncation notice instead of just a count", () => {
    const { context } = buildSynthesisContext(manyEntities(200, 1500));
    // Entity 0 is protected (rank-1) and always fits; later entities are the
    // ones that get cut, so their titles ("Entity N") should be named.
    expect(context).toMatch(/omitted: "Entity \d+"/);
  });

  it("keeps the truncation notice itself under the IS cap regardless of how many/long the omitted titles are", () => {
    const huge: AskAnswer[] = [
      {
        substrate: "structured",
        status: "ok",
        items: Array.from({ length: 300 }, (_, i) => ({
          id: `e${i}`,
          // A title far longer than the per-name slice, to prove the notice
          // hard-caps itself rather than growing unboundedly with the data.
          title: `Entity ${i} ${"x".repeat(200)}`,
          content: "z".repeat(1500),
        })),
      },
    ] as unknown as AskAnswer[];
    const { context } = buildSynthesisContext(huge);
    // Whole context (entries + notice) must still respect the 20k IS cap.
    expect(context.length).toBeLessThanOrEqual(IS_CONTEXT_MAX);
    const notice = context.split("\n").find((l) => l.includes("[NOTICE]"));
    expect(notice).toBeDefined();
    expect(notice!.length).toBeLessThanOrEqual(300);
  });
});

describe("buildSynthesisContext — rank-1 protection", () => {
  // A short LOW-ranked item and a long HIGH-ranked (rank-1) item: fit-based
  // admission alone would keep the short one and drop the long one, silently
  // dropping the single most relevant result. Rank-1 must be admitted
  // unconditionally.
  it("always admits the first (highest-ranked) item even when it is the largest", () => {
    const answers: AskAnswer[] = [
      {
        substrate: "structured",
        status: "ok",
        items: [
          { id: "rank1", title: "Most relevant", content: "y".repeat(19_000) },
          { id: "rank2", title: "Less relevant", content: "short" },
        ],
      },
    ] as unknown as AskAnswer[];
    const { context } = buildSynthesisContext(answers);
    expect(context).toContain("Most relevant");
  });

  it("hard-caps the protected first entry so it alone can never blow the IS budget", () => {
    // An entity whose `title` column is null falls back to the (unsliced, up
    // to 64k-char) `content` field as its title — the one field this builder
    // does not slice anywhere else. Prove that even in that pathological
    // shape, a single protected-first entry cannot exceed the budget.
    const pathological: AskAnswer[] = [
      {
        substrate: "structured",
        status: "ok",
        items: [{ id: "e1", content: "q".repeat(64_000) }],
      },
    ] as unknown as AskAnswer[];
    const { context } = buildSynthesisContext(pathological);
    expect(context.length).toBeLessThanOrEqual(IS_CONTEXT_MAX);
  });
});
