/**
 * ONE slide rule, two readers. The pod names a page's slides in its block
 * manifest (`htmlBlockManifest`, parsing the source); the in-frame SDK names
 * them again from the DOM it runs (`CELL_BRIDGE_SDK`, `@synap-core/types/
 * cell-bridge` `slides.ts`) when a host presents the page. A host reads the
 * deck from the manifest and drives the frame by those ids, so the two must
 * give every slide the same id at the same position.
 *
 * Drives the REAL SDK on a REAL DOM (linkedom) of the same page the REAL
 * extractor reads: each manifest slide, asked by its id (with a position
 * that cannot be followed) and by its position (with an id no slide has),
 * must come back as that id and that position.
 *
 * NOT covered: a page whose DOM differs from its source (a script that adds
 * or removes slides, a parser repair that moves an element); the frame then
 * reports what it shows and the host follows its position.
 */
import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import {
  CELL_BRIDGE_SDK,
  frameSlideGoto,
  parseFrameSlideChanged,
} from "@synap-core/types/cell-bridge";
import { htmlBlockManifest } from "./html-blocks.js";

const DECK = `<!doctype html>
<html><head><title>Pitch</title></head>
<body>
<section data-slide="intro"><h1>Hello</h1></section>
<section data-block-id="toc"><p>Contents (a section, not a slide)</p></section>
<section data-slide><h2>Problem</h2><div data-block-id="pain"><p>Two</p></div></section>
<section data-slide data-block-id="ask"><h2>The ask</h2></section>
<article data-slide="  "><h2>Blank value</h2></article>
<section data-slide=" market "><h2>Market</h2></section>
</body></html>`;

function bootSdk(html: string) {
  const { document } = parseHTML(html);
  const listeners: Array<(e: { source: unknown; data: unknown }) => void> = [];
  const posted: unknown[] = [];
  const parent = { postMessage: (msg: unknown) => posted.push(msg) };
  const win = {
    parent,
    document,
    addEventListener: (type: string, fn: (e: { source: unknown; data: unknown }) => void) => {
      if (type === "message") listeners.push(fn);
    },
  };
  new Function("window", CELL_BRIDGE_SDK)(win);
  const ask = (slideId: string, index: number) => {
    posted.length = 0;
    listeners.forEach((fn) => fn({ source: parent, data: frameSlideGoto(slideId, index) }));
    return posted.map(parseFrameSlideChanged);
  };
  return { ask, document };
}

describe("the slide rule: the frame names slides as the pod's manifest does", () => {
  const slides = htmlBlockManifest(DECK).filter((b) => b.kind === "slide");

  it("the manifest sees the deck (non-vacuity)", () => {
    expect(slides.map((s) => s.id)).toEqual(["intro", "slide-2", "ask", "slide-4", "market"]);
  });

  it("every manifest slide, asked by its id, is shown at its position", () => {
    const { ask } = bootSdk(DECK);
    slides.forEach((slide, position) => {
      expect(ask(slide.id, 9_999)).toEqual([
        { type: "synap:slide:changed", slideId: slide.id, index: position, total: slides.length },
      ]);
    });
  });

  it("every position, asked with an id no slide has, is reported under the manifest's id", () => {
    const { ask, document } = bootSdk(DECK);
    slides.forEach((slide, position) => {
      expect(ask("not-a-slide", position)[0]?.slideId).toBe(slide.id);
      // Shown alone: the current mark is on that slide only.
      expect(document.querySelectorAll("[data-synap-slide-current]").length).toBe(1);
    });
  });
});
