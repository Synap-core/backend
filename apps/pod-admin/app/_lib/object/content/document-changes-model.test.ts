import { describe, expect, it } from "vitest";
import { documentChanges } from "./document-changes-model";

describe("documentChanges — a document edit proposal, readable", () => {
  it("is null for a payload with no preview", () => {
    expect(documentChanges(undefined)).toBeNull();
    expect(documentChanges({ title: "Task" })).toBeNull();
    expect(documentChanges({ preview: "nope" })).toBeNull();
  });

  it("diffs prose word by word and folds what stayed the same", () => {
    const out = documentChanges({
      preview: [
        {
          sectionId: "plan",
          title: "Plan",
          before: "Intro.\n\nShip on Monday.\n\nOutro.",
          after: "Intro.\n\nShip on Friday.\n\nOutro.",
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out![0]!.title).toBe("Plan");
    expect(out![0]!.lines.map((l) => l.op)).toEqual([
      "unchanged",
      "change",
      "unchanged",
    ]);
    const change = out![0]!.lines[1];
    expect(change).toMatchObject({
      op: "change",
      before: "Ship on Monday.",
      after: "Ship on Friday.",
    });
    expect(change?.op === "change" && change.words).toEqual([
      { op: "same", text: "Ship on " },
      { op: "del", text: "Monday." },
      { op: "add", text: "Friday." },
    ]);
  });

  it("names additions and removals, and diffs inside a section container", () => {
    const out = documentChanges({
      preview: [
        {
          sectionId: null,
          title: null,
          before: ':::synap-section{id="a"}\nKeep.\n:::',
          after: ':::synap-section{id="a"}\nKeep.\n\n- new item\n:::',
        },
      ],
    });
    expect(out![0]!.key).toBe("region-0");
    expect(out![0]!.title).toBeNull();
    expect(out![0]!.lines).toEqual([
      { op: "unchanged", count: 1 },
      { op: "add", text: "- new item" },
    ]);
  });

  it("drops regions that do not change anything", () => {
    expect(
      documentChanges({
        preview: [
          { sectionId: "s", title: "S", before: "Same.", after: "Same." },
        ],
      })
    ).toBeNull();
  });
});
