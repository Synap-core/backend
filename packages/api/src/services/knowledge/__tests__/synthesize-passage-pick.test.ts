/**
 * A long document body reaches synthesis by its PASSAGES, chosen for the
 * question — not its first 1,500 chars (plan-recall A-W1, evidence c453a66b).
 *
 * Live defect: an answer that sits past char ~1,200 of a 2k-15k-word note was
 * never shown to the model, which then said the note did not hold it. Pinned:
 *  - the passage holding the answer at char ~9,000 is in the context, under an
 *    OUTLINE that names every section shown or omitted;
 *  - a body that fits is sent whole, unchanged;
 *  - with no question words to rank by, a long body keeps its head AND tail;
 *  - several long bodies still fit the IS context cap;
 *  - a body that could not be read says so.
 */
import { describe, it, expect } from "vitest";
import { buildSynthesisContext } from "../synthesize.js";
import type { AskAnswer } from "../ask.js";

/** The literal cap in intelligence-hub/src/routes/knowledge-answer.ts. */
const IS_CONTEXT_MAX = 20000;

const filler = (tag: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `${tag} ${i}: the team reviewed the backlog, the roadmap and the hiring plan in detail.`
  ).join("\n\n");

const ANSWER = "The board agreed a seat price of 49 EUR per month.";

/** ~11k chars; the answer sits in "Commercial terms", past char 9,000. */
const LONG_NOTE = [
  "# Board meeting, October",
  `## Attendees and agenda\n\n${filler("agenda", 25)}`,
  `## Product review\n\n${filler("product", 75)}`,
  `## Commercial terms\n\n${filler("terms", 6)}\n\n${ANSWER}\n\n${filler("terms-after", 4)}`,
  `## Next steps\n\n${filler("next", 20)}`,
].join("\n\n");

const entity = (id: string, title: string, content: unknown): AskAnswer =>
  ({
    substrate: "semantic",
    status: "ok",
    items: [{ id, title, content }],
  }) as unknown as AskAnswer;

describe("buildSynthesisContext — a long body is sent by its passages", () => {
  it("the passage holding the answer at char ~9,000 reaches the context", () => {
    expect(LONG_NOTE.indexOf(ANSWER)).toBeGreaterThan(9_000);
    const { context } = buildSynthesisContext(
      [entity("n1", "Board meeting", LONG_NOTE)],
      "what seat price did the board agree?"
    );
    expect(context).toContain(ANSWER);
    expect(context).toMatch(/OUTLINE \(\d+ sections, \d+ chars\)/);
    expect(context).toMatch(/Commercial terms \[shown\]/);
    expect(context).toMatch(/Product review[^·]*\[omitted\]/);
    expect(context).toMatch(/\[clipped: \d+ chars omitted\]/);
    expect(context.length).toBeLessThan(LONG_NOTE.length);
  });

  it("a body that fits is sent whole, unchanged", () => {
    const short = "## Pricing\n\nThe seat price is 49 EUR.";
    const { context } = buildSynthesisContext(
      [entity("n1", "Pricing", short)],
      "what is the seat price?"
    );
    expect(context).toContain(`content: ${short}`);
    expect(context).not.toContain("OUTLINE");
  });

  it("with no question words to rank by, a long body keeps its head and tail", () => {
    const { context } = buildSynthesisContext([
      entity("n1", "Board meeting", LONG_NOTE),
    ]);
    expect(context).toContain("# Board meeting, October");
    expect(context).toContain("next 19:");
    expect(context).not.toContain("OUTLINE");
  });

  it("several long bodies stay under the IS context cap", () => {
    const answers = Array.from({ length: 12 }, (_, i) =>
      entity(`n${i}`, `Note ${i}`, LONG_NOTE)
    );
    const { context, truncated } = buildSynthesisContext(
      answers,
      "what seat price did the board agree?"
    );
    expect(context.length).toBeLessThanOrEqual(IS_CONTEXT_MAX);
    expect(truncated?.omitted).toBeGreaterThan(0);
  });

  it("a body that could not be read says so instead of reading as empty", () => {
    const answers = [
      {
        substrate: "semantic",
        status: "ok",
        items: [
          { id: "n1", title: "Board meeting", contentReadError: "S3 timeout" },
        ],
      },
    ] as unknown as AskAnswer[];
    const { context } = buildSynthesisContext(answers, "seat price");
    expect(context).toContain(
      "content: [the document body could not be read: S3 timeout]"
    );
  });
});
