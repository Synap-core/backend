import { describe, expect, it } from "vitest";
import { receiverWidthClass } from "./receiver-shell";

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

  it("actually distinguishes the two — an inert prop returns one value", () => {
    expect(receiverWidthClass("sm")).not.toBe(receiverWidthClass("md"));
  });
});
