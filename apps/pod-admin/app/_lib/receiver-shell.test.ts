import { describe, expect, it } from "vitest";
import { receiverWidthClass } from "./receiver-shell";

/**
 * `width` was live for one commit as an INERT prop: declared, defaulted,
 * documented, passed by `/invite`, `/approve-agent` and `/oauth/consent`, and
 * never read — so all three single-decision cards rendered at `max-w-2xl`.
 * tsc was green throughout. This is the assertion that would have caught it.
 */
describe("receiverWidthClass", () => {
  it("narrows a single-decision card", () => {
    expect(receiverWidthClass("sm")).toBe("max-w-md");
  });

  it("keeps the object-reading card wide", () => {
    expect(receiverWidthClass("md")).toBe("max-w-2xl");
  });

  it("actually distinguishes the two — an inert prop returns one value", () => {
    expect(receiverWidthClass("sm")).not.toBe(receiverWidthClass("md"));
  });
});
