import { describe, it, expect } from "vitest";
import { ASK_NUDGE, askNudgeFor, findProseQuestion, patchOpTexts } from "./ask-nudge.js";

const Q = "# Plan\n\n## Open questions\n\n- Should we ship the change on Friday?\n";
const ASK = ":::synap-ask\n```json\n{\"ask\":{\"mode\":\"confirm\",\"prompt\":\"Ship?\"}}\n```\n\nShip?\n:::\n";

describe("ask nudge", () => {
  it("nudges a prose question under a question heading", () => {
    expect(askNudgeFor([Q])).toBe(ASK_NUDGE);
    expect(findProseQuestion("## Decisions needed\n\n1. **Which vendor do we pick?**\n")).toBe(
      "Which vendor do we pick?"
    );
  });
  it("is quiet when an ask block exists, definition or reference", () => {
    expect(askNudgeFor([Q + ASK])).toBeNull();
    expect(
      askNudgeFor([Q + ':::synap-ask{sessionId="s" slot="k"}\n:::\n'])
    ).toBeNull();
  });
  it("is quiet outside question headings, in code, and for rhetorical prose", () => {
    expect(askNudgeFor(["# Notes\n\nWhy does this matter?\n"])).toBeNull();
    expect(askNudgeFor(["## Open questions\n\n```\nWhat is this thing here?\n```\n"])).toBeNull();
    expect(askNudgeFor(["## Open questions\n\nNone.\n"])).toBeNull();
  });
  it("is quiet when the document already holds an ask the patch does not touch", () => {
    expect(askNudgeFor(patchOpTexts([{ op: "append", body: Q } as never]), ASK + Q)).toBeNull();
  });
  it("reads a section op's title as its heading", () => {
    const texts = patchOpTexts([
      { op: "upsert_section", id: "q", title: "Open questions", body: "- Which one do you want?" } as never,
    ]);
    expect(askNudgeFor(texts)).toBe(ASK_NUDGE);
  });
});
