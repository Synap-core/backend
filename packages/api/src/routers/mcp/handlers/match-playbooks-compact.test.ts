import { describe, expect, it } from "vitest";
import {
  compactPlaybookMatches,
  MATCH_GOAL_TEMPLATE_CAP,
} from "./match-playbooks-compact.js";

const intent = (id: string, score: number, goalTemplate = "g") => ({
  id,
  score,
  goalTemplate,
  signals: [{ type: "intent" }, { type: "anyKind" }],
});

// Shape of the live call: one strong row, then a tail carried by one shared word.
const LIVE = [
  intent("fix-wave", 21),
  intent("release", 12),
  ...Array.from({ length: 17 }, (_, i) => intent(`tail-${i}`, 1.5)),
];

describe("compactPlaybookMatches", () => {
  it("19 rows become 2: the tail riding on one shared word is dropped", () => {
    expect(compactPlaybookMatches(LIVE, undefined).map((r) => r.id)).toEqual([
      "fix-wave",
      "release",
    ]);
  });

  it("defaults to 5 rows and honours limit up to 20", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      intent(`r${i}`, 10 - i * 0.1)
    );
    expect(compactPlaybookMatches(rows, undefined)).toHaveLength(5);
    expect(compactPlaybookMatches(rows, 9)).toHaveLength(9);
    expect(compactPlaybookMatches(rows, 500)).toHaveLength(12);
    expect(compactPlaybookMatches(rows, 0)).toHaveLength(1);
    expect(compactPlaybookMatches(rows, "lots")).toHaveLength(5);
  });

  it("truncates goalTemplate and leaves short ones", () => {
    const [long, short] = compactPlaybookMatches(
      [intent("a", 5, "x".repeat(900)), intent("b", 5, "short")],
      undefined
    );
    expect(long!.goalTemplate.length).toBe(MATCH_GOAL_TEMPLATE_CAP + 1);
    expect(short!.goalTemplate).toBe("short");
  });

  it("a kind match is entity evidence and stays below the floor", () => {
    const kind = {
      id: "k",
      score: 2,
      goalTemplate: "g",
      signals: [{ type: "kind" }],
    };
    const out = compactPlaybookMatches([intent("top", 30), kind], undefined);
    expect(out.map((r) => r.id)).toEqual(["top", "k"]);
  });
});
