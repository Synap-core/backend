import { describe, expect, it } from "vitest";
import { isReaderObject, readerBodyClass, readerLayout } from "./reader-model";

/**
 * Which `/open` objects read in the full-window reader: decided once here,
 * read by every hosted page. A view fills, a document reads at its frame,
 * every small object keeps the card, and nothing that is not drawn leaves it.
 */
describe("readerLayout: big content reads in the window", () => {
  it("a drawn view (board, bento, whiteboard) fills the window", () => {
    expect(readerLayout("view", { drawn: true })).toBe("fill");
    expect(isReaderObject("view", { drawn: true })).toBe(true);
  });

  it("a drawn document reads at the document frame", () => {
    expect(readerLayout("document", { drawn: true })).toBe("document");
    expect(isReaderObject("document", { drawn: true })).toBe(true);
  });

  it("small objects keep the card, drawn or not", () => {
    for (const type of [
      "entity",
      "session",
      "playbook",
      "run",
      "automation",
      "capability",
      "agent",
      "channel",
      "track",
      "skill",
      "tool",
      "cell",
    ]) {
      expect(readerLayout(type, { drawn: true }), type).toBeNull();
      expect(isReaderObject(type, { drawn: true }), type).toBe(false);
    }
  });

  it("content that is not drawn keeps the card (its hand-off is the one door)", () => {
    expect(readerLayout("view", { drawn: false })).toBeNull();
    expect(readerLayout("document", { drawn: false })).toBeNull();
    expect(isReaderObject("view", { drawn: false })).toBe(false);
  });

  it("an inherited key is not a kind", () => {
    expect(readerLayout("constructor", { drawn: true })).toBeNull();
    expect(readerLayout("toString", { drawn: true })).toBeNull();
  });
});

describe("readerBodyClass: the two frames differ", () => {
  it("fill takes the whole width; document reads at 80% from 1024px, at most 72rem", () => {
    expect(readerBodyClass("fill")).toContain("w-full");
    expect(readerBodyClass("fill")).not.toContain("max-w-");
    expect(readerBodyClass("document")).toContain("max-w-6xl");
    expect(readerBodyClass("document")).toContain("lg:w-4/5");
  });
});
