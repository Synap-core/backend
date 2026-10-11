import { describe, it, expect } from "vitest";
import {
  classifyLifecycleMove,
  parseLifecycleOptions,
  LIFECYCLE_CATEGORIES,
} from "./lifecycle-model.js";

describe("lifecycle model", () => {
  it("categories are the fixed five, in order", () => {
    expect([...LIFECYCLE_CATEGORIES]).toEqual([
      "open",
      "active",
      "paused",
      "done",
      "lost",
    ]);
  });

  it("parses options and refuses a missing / unknown category", () => {
    const ok = parseLifecycleOptions([
      { key: "draft", category: "open" },
      { key: "won", category: "done", label: "Won", humanOnly: true },
    ]);
    expect(ok.errors).toEqual([]);
    expect(ok.options[1]).toEqual({
      key: "won",
      category: "done",
      label: "Won",
      humanOnly: true,
    });

    const bad = parseLifecycleOptions([
      { key: "draft" },
      { key: "x", category: "closed" },
      { key: "y", category: "open" },
      { key: "y", category: "open" },
    ]);
    expect(bad.errors).toHaveLength(3);
    expect(bad.options.map((o) => o.key)).toEqual(["y"]);
    expect(parseLifecycleOptions([]).errors).toHaveLength(1);
  });

  it("classifies a move by the TARGET option's category", () => {
    const decl = {
      options: [
        { key: "draft", category: "open" as const },
        { key: "negotiating", category: "active" as const },
        { key: "won", category: "done" as const, humanOnly: true },
        { key: "lost", category: "lost" as const },
      ],
    };
    expect(classifyLifecycleMove(decl, "negotiating")).toEqual({
      toCategory: "active",
      intoTerminal: false,
      humanOnly: false,
    });
    expect(classifyLifecycleMove(decl, "lost")?.intoTerminal).toBe(true);
    expect(classifyLifecycleMove(decl, "won")).toEqual({
      toCategory: "done",
      intoTerminal: true,
      humanOnly: true,
    });
    expect(classifyLifecycleMove(decl, "nope")).toBeNull();
  });
});
