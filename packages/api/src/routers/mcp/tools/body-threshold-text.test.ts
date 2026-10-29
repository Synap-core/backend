/**
 * Ticket 69987248 — the body doors say WHERE a body is stored, and what they
 * say is the rule the create door applies.
 *
 * `synap_create_entity` told agents its `content` was "materialized into a
 * versioned document" — always. The door (`entity-body-service.ts` →
 * `shouldMaterializeAsDocument`) inlines a SHORT body into the `content`
 * property instead, so a short decision or research body landed where its
 * card shows nothing. Making every body a document waits on the readers (the
 * decision / research detail cards render no body slot); until then the text
 * must state the threshold.
 *
 * Behavioural on the rule: each number the text names is run through the real
 * heuristic at its boundary, so changing one without the other goes red.
 */
import { describe, it, expect } from "vitest";
import { shouldMaterializeAsDocument } from "@synap-core/types/documents";
import { tools } from "./index.js";

type Schema = Record<string, any>;

async function contentDescriptions(): Promise<string[]> {
  const list = (await tools.list()) as Array<{
    name: string;
    inputSchema: Schema;
  }>;
  const of = (name: string) => list.find((t) => t.name === name)!.inputSchema;
  return [
    of("synap_create_entity").properties.content.description,
    of("synap_capture").properties.entities.items.properties.content
      .description,
  ];
}

describe("the body threshold the tools state is the one the door applies", () => {
  it("both body doors state it, and neither says 'always a document'", async () => {
    const texts = await contentDescriptions();
    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(text).toContain(
        "600+ characters, or 2+ headings, a code fence, 3+ list items or 4+ paragraphs"
      );
      expect(text).toContain("stored inline as the `content` property");
    }
  });

  it("each number is the heuristic's boundary", () => {
    expect(shouldMaterializeAsDocument("x".repeat(599))).toBe(false);
    expect(shouldMaterializeAsDocument("x".repeat(600))).toBe(true);
    expect(shouldMaterializeAsDocument("# a\ntext")).toBe(false);
    expect(shouldMaterializeAsDocument("# a\n# b")).toBe(true);
    expect(shouldMaterializeAsDocument("```\ncode\n```")).toBe(true);
    expect(shouldMaterializeAsDocument("- a\n- b")).toBe(false);
    expect(shouldMaterializeAsDocument("- a\n- b\n- c")).toBe(true);
    expect(shouldMaterializeAsDocument("a\n\nb\n\nc")).toBe(false);
    expect(shouldMaterializeAsDocument("a\n\nb\n\nc\n\nd")).toBe(true);
  });
});
