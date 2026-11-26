/**
 * Addressable blocks of an HTML artifact: the manifest extractor and the
 * `replace_block` patch op, driven through the REAL patch renderer
 * (`renderDocumentPatch`, the door every document patch goes through).
 */

import { describe, it, expect } from "vitest";
import {
  htmlBlockManifest,
  locateHtmlBlocks,
  replaceHtmlBlock,
  HtmlBlockError,
} from "./html-blocks.js";
import { DocumentPatchOpsSchema, renderDocumentPatch } from "./patch-ops.js";

const DECK = `<!doctype html>
<html><head><title>Pitch</title><style>section{padding:1rem}</style></head>
<body>
<section data-slide="intro"><h1>Hello <em>world</em></h1><p>One.</p></section>
<section data-slide><h2>Problem</h2><div data-block-id="pain" data-title="The pain"><p>Two</p></div></section>
<section data-slide data-block-id="ask">
  <h2>The   ask</h2>
  <img data-block-id="logo" src="data:image/png;base64,AAAA">
  <svg><rect data-block-id="dot" width="1" height="1"/></svg>
</section >
<script>var s = '<section data-block-id="fake">';</script>
</body></html>`;

const agent = { isMachine: true, author: "agent-1" };

describe("htmlBlockManifest — what a page's blocks are", () => {
  it("lists every block in document order with kind, id and title", () => {
    expect(htmlBlockManifest(DECK)).toEqual([
      { id: "intro", kind: "slide", order: 0, title: "Hello world" },
      { id: "slide-2", kind: "slide", order: 1, title: "Problem" },
      { id: "pain", kind: "section", order: 2, title: "The pain" },
      { id: "ask", kind: "slide", order: 3, title: "The ask" },
      { id: "logo", kind: "section", order: 4, title: null },
      { id: "dot", kind: "section", order: 5, title: null },
    ]);
  });

  it("never reads markup inside a script as a block", () => {
    expect(htmlBlockManifest(DECK).map((b) => b.id)).not.toContain("fake");
  });

  it("locates each block's exact source span (void and self-closed included)", () => {
    const spans = Object.fromEntries(
      locateHtmlBlocks(DECK).map((b) => [b.id, DECK.slice(b.start, b.end)])
    );
    expect(spans.intro).toBe(
      `<section data-slide="intro"><h1>Hello <em>world</em></h1><p>One.</p></section>`
    );
    expect(spans.pain).toBe(
      `<div data-block-id="pain" data-title="The pain"><p>Two</p></div>`
    );
    expect(spans.logo).toBe(
      `<img data-block-id="logo" src="data:image/png;base64,AAAA">`
    );
    expect(spans.dot).toBe(`<rect data-block-id="dot" width="1" height="1"/>`);
    expect(spans.ask!.endsWith("</section >")).toBe(true);
  });

  it("an empty page, or one with no convention, has no blocks", () => {
    expect(htmlBlockManifest("")).toEqual([]);
    expect(htmlBlockManifest("<p>plain</p>")).toEqual([]);
  });
});

describe("replace_block — one block changes, nothing else", () => {
  it("replaces exactly that element's outer HTML; every other byte stays", () => {
    const next = replaceHtmlBlock(
      DECK,
      "pain",
      `<div data-block-id="pain"><p>Three &amp; four</p></div>`
    );
    const was = locateHtmlBlocks(DECK).find((b) => b.id === "pain")!;
    expect(next.slice(0, was.start)).toBe(DECK.slice(0, was.start));
    expect(next.endsWith(DECK.slice(was.end))).toBe(true);
    expect(next).toContain(
      `<div data-block-id="pain"><p>Three &amp; four</p></div>`
    );
    expect(next).not.toContain("<p>Two</p>");
  });

  it("goes through the patch renderer as a governed op", () => {
    const ops = DocumentPatchOpsSchema.parse([
      {
        op: "replace_block",
        blockId: "intro",
        html: `<section data-slide="intro"><h1>Hi</h1></section>`,
      },
    ]);
    const rendered = renderDocumentPatch(DECK, ops, { writer: agent });
    expect(rendered.markdown).toContain(
      `<section data-slide="intro"><h1>Hi</h1></section>`
    );
    // Every other block reads byte for byte as before.
    const before = locateHtmlBlocks(DECK).filter((b) => b.id !== "intro");
    const after = locateHtmlBlocks(rendered.markdown);
    for (const b of before) {
      const a = after.find((x) => x.id === b.id)!;
      expect(rendered.markdown.slice(a.start, a.end)).toBe(
        DECK.slice(b.start, b.end)
      );
    }
    expect(htmlBlockManifest(rendered.markdown)[0]?.title).toBe("Hi");
  });

  it("refuses an unknown id, naming the blocks there are", () => {
    expect(() =>
      renderDocumentPatch(
        DECK,
        DocumentPatchOpsSchema.parse([
          { op: "replace_block", blockId: "nope", html: "<div></div>" },
        ]),
        { writer: agent }
      )
    ).toThrow(/no block "nope".*"intro"/);
  });

  it("refuses a duplicated id", () => {
    const html = `<div data-block-id="a">1</div><div data-block-id="a">2</div>`;
    expect(() =>
      replaceHtmlBlock(html, "a", `<div data-block-id="a">3</div>`)
    ).toThrow(HtmlBlockError);
  });

  it("refuses new HTML that drops the block id", () => {
    expect(() => replaceHtmlBlock(DECK, "pain", `<div><p>x</p></div>`)).toThrow(
      /keeps data-block-id="pain"/
    );
  });

  it("refuses new HTML that reaches past the block into a sibling", () => {
    const html = `<main><div data-block-id="a">1</div><div data-block-id="b">2</div></main>`;
    // An open comment swallows block "b" (and the rest of the page).
    expect(() =>
      replaceHtmlBlock(html, "a", `<div data-block-id="a">1</div><!--`)
    ).toThrow(/changes block "b" too/);
  });

  it("refuses a block whose closing tag was never written", () => {
    const html = `<ul><li data-block-id="x">one<li>two</ul>`;
    expect(() =>
      replaceHtmlBlock(html, "x", `<li data-block-id="x">uno</li>`)
    ).toThrow(/no closing tag/);
  });
});
