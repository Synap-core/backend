import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { visit } from "unist-util-visit";
import {
  DIRECTIVE_ATTRIBUTES,
  remarkSynapDirectives,
} from "./directive-registry.js";
import { createMarkdownProcessor } from "./processor.js";
import { segmentSlides } from "./sections.js";

/**
 * CONTRACT TEST: the pod's CLOSING REPORT ⇄ this read path.
 *
 * The report is built by the api package
 * (`services/session-document/closing-report.ts`) with the line scanner. Its
 * own test pins the builder's output byte-for-byte to the golden file read
 * here; this side parses that SAME file with the real pipeline — so a builder
 * change that emits an unregistered directive, an attribute the allowlist
 * would drop, or a fence that swallows the next section fails HERE.
 *
 * The golden lives in the backend repo on purpose (one copy, owned by the
 * producer). A missing file fails loudly rather than skipping.
 */
const GOLDEN = fileURLToPath(
  new URL(
    "../../api/src/services/session-document/__fixtures__/closing-report.golden.md",
    import.meta.url
  )
);

type DirectiveNode = {
  type: string;
  name: string;
  attributes?: Record<string, string>;
  children?: DirectiveNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
};

function parse(markdown: string) {
  // The renderer's exact stack: the shared pipeline + the hast mapping.
  const processor = createMarkdownProcessor().use(remarkSynapDirectives);
  return processor.runSync(processor.parse(markdown), markdown) as unknown as {
    children: DirectiveNode[];
  };
}

describe("closing report golden → markdown-engine", () => {
  it("the golden exists (a missing producer file is a failure, not a skip)", () => {
    expect(existsSync(GOLDEN)).toBe(true);
  });

  const body = existsSync(GOLDEN) ? readFileSync(GOLDEN, "utf-8") : "";
  const tree = parse(body);

  it("four top-level synap-sections, nothing leaking between them", () => {
    const top = tree.children.filter((n) => n.type === "containerDirective");
    expect(top.map((n) => n.name)).toEqual([
      "synap-section",
      "synap-section",
      "synap-section",
      "synap-section",
    ]);
    // Every top-level node is a section — no stray text or fence escaped one.
    expect(tree.children).toHaveLength(4);
  });

  it("every directive is registered and keeps EVERY attribute through the allowlist", () => {
    const seen: string[] = [];
    visit(
      tree as never,
      ["containerDirective", "leafDirective", "textDirective"],
      (node: DirectiveNode) => {
        seen.push(node.name);
        const allowed = (
          DIRECTIVE_ATTRIBUTES as Record<string, readonly string[]>
        )[node.name];
        expect(allowed, `unregistered directive ${node.name}`).toBeDefined();
        const attrs = Object.keys(node.attributes ?? {});
        expect(attrs.filter((a) => !allowed!.includes(a))).toEqual([]);
        expect(Object.keys(node.data?.hProperties ?? {}).sort()).toEqual(
          attrs.sort()
        );
      }
    );
    // Non-vacuity: the scan saw the sections AND the entity embeds.
    expect(seen.filter((n) => n === "synap-section")).toHaveLength(4);
    expect(
      seen.filter((n) => n === "synap-entity").length
    ).toBeGreaterThanOrEqual(2);
  });

  it("entity embeds are reference-only (an id, nothing else) and live INSIDE 'What was produced'", () => {
    const produced = tree.children[2]!;
    const embeds = (produced.children ?? []).filter(
      (n) => n.name === "synap-entity"
    );
    expect(embeds.length).toBeGreaterThanOrEqual(2);
    for (const e of embeds)
      expect(Object.keys(e.attributes ?? {})).toEqual(["id"]);
  });

  it("the definition of done is a real GFM table and its status is never 'failed'", () => {
    const dod = tree.children[1]!;
    expect((dod.children ?? []).some((n) => n.type === "table")).toBe(true);
    expect(dod.attributes?.status).not.toBe("failed");
  });

  it("segments into one slide per section, each titled by its heading", () => {
    const titles = segmentSlides(body).map((s) => s.title);
    expect(titles).toEqual([
      "Outcome",
      "Definition of done",
      "What was produced",
      "Decisions",
    ]);
  });
});
