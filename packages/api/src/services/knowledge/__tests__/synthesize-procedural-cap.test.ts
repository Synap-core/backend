/**
 * `MAX_PROCEDURAL_ROWS` was declared and checked, but the admitted counter was a
 * `const 0` that never moved, so the cap never fired and runbooks filled the
 * context of unrelated questions.
 */
import { describe, it, expect } from "vitest";
import { buildSynthesisContext } from "../synthesize.js";
import type { AskAnswer } from "../ask.js";

describe("buildSynthesisContext — procedural row cap", () => {
  it("admits at most 2 procedural rows, however many matched", () => {
    const answers = [
      {
        substrate: "procedural",
        status: "ok",
        items: Array.from({ length: 5 }, (_, i) => ({
          id: `rb-${i}`,
          key: `codestate:runbook-${i}`,
          namespace: "codestate",
          slug: `runbook-${i}`,
          value: `body ${i}`,
        })),
      },
    ] as unknown as AskAnswer[];
    const { context, truncated } = buildSynthesisContext(answers);
    expect(context.match(/\[procedural/g)).toHaveLength(2);
    expect(truncated?.omitted).toBe(3);
  });
});
