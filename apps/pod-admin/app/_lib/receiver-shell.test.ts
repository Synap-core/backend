import { describe, expect, it } from "vitest";
import {
  READS_WIDE_ATTR,
  receiverCardClass,
  receiverWidthClass,
} from "./receiver-shell";

/**
 * `width` was live for one commit as an INERT prop: declared, defaulted,
 * documented, passed by `/invite`, `/approve-agent` and `/oauth/consent`, and
 * never read — so all three single-decision cards rendered at `max-w-2xl`.
 * tsc was green throughout. This is the assertion that would have caught it.
 */
describe("receiverWidthClass", () => {
  it("lg reads wide: 80% of the window from 1024px, at most 72rem", () => {
    expect(receiverWidthClass("lg")).toBe("max-w-6xl lg:w-4/5");
    expect(receiverWidthClass("lg")).not.toBe(receiverWidthClass("md"));
  });

  it("narrows a single-decision card", () => {
    expect(receiverWidthClass("sm")).toBe("max-w-md");
  });

  it("keeps the object-reading card wide", () => {
    expect(receiverWidthClass("md")).toBe("max-w-2xl");
  });

  it("auto reads at md, and at lg's two classes when the card holds the mark", () => {
    const auto = receiverWidthClass("auto").split(" ");
    const mark = `has-[[${READS_WIDE_ATTR}]]`;
    expect(auto[0]).toBe(receiverWidthClass("md"));
    // Every lg class, gated on the mark — the same attribute the content sets.
    for (const cls of receiverWidthClass("lg").split(" ")) {
      const [bp, utility] = cls.includes(":") ? cls.split(":") : ["", cls];
      expect(auto).toContain(
        bp ? `${bp}:${mark}:${utility}` : `${mark}:${utility}`
      );
    }
    expect(auto).toHaveLength(3);
  });

  it("actually distinguishes the two — an inert prop returns one value", () => {
    expect(receiverWidthClass("sm")).not.toBe(receiverWidthClass("md"));
  });
});

/**
 * A HeroUI card clips (`overflow-hidden`), and a clipping box that does not
 * scroll is where a sticky child pins: the proposal page's decision bar stayed
 * at the bottom of a 34,545 px review. `pinsBar` must lift the clip.
 */
describe("receiverCardClass", () => {
  it("a card that pins a bar clips nothing", () => {
    expect(receiverCardClass(true)).toContain("overflow-visible");
  });

  it("every other card keeps its clip", () => {
    expect(receiverCardClass(false)).not.toContain("overflow-visible");
  });
});
