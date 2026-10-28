import { describe, expect, it } from "vitest";
import {
  documentChanges,
  foldUnchanged,
  lineCounts,
  lineDiff,
} from "./document-changes-model";

describe("documentChanges — a document edit proposal, readable", () => {
  it("is null for a payload with no preview", () => {
    expect(documentChanges(undefined)).toBeNull();
    expect(documentChanges({ title: "Task" })).toBeNull();
    expect(documentChanges({ preview: "nope" })).toBeNull();
  });

  it("diffs prose word by word and keeps what stayed the same, in place", () => {
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
    expect(out![0]!.lines.map((l) => l.op)).toEqual(["same", "change", "same"]);
    // The whole text rides along, for the Lines reading.
    expect(out![0]!.before).toBe("Intro.\n\nShip on Monday.\n\nOutro.");
    expect(out![0]!.after).toBe("Intro.\n\nShip on Friday.\n\nOutro.");
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
      { op: "same", text: "Keep." },
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

describe("lineDiff — the source, line by line", () => {
  it("numbers both sides and pairs a replaced line word by word", () => {
    const rows = lineDiff("a\nShip on Monday.\nc", "a\nShip on Friday.\nc\nd");
    expect(rows.map((r) => r.op)).toEqual([
      "same",
      "del",
      "add",
      "same",
      "add",
    ]);
    expect(rows[0]).toMatchObject({ op: "same", oldNo: 1, newNo: 1 });
    expect(rows[1]).toMatchObject({ op: "del", oldNo: 2 });
    expect(rows[2]).toMatchObject({ op: "add", newNo: 2 });
    expect(rows[3]).toMatchObject({ op: "same", oldNo: 3, newNo: 3 });
    expect(rows[4]).toMatchObject({ op: "add", text: "d", newNo: 4 });
    expect(rows[1]!.op === "del" && rows[1]!.words).toEqual([
      { op: "same", text: "Ship on " },
      { op: "del", text: "Monday." },
    ]);
    expect(rows[2]!.op === "add" && rows[2]!.words).toEqual([
      { op: "same", text: "Ship on " },
      { op: "add", text: "Friday." },
    ]);
    expect(lineCounts(rows)).toEqual({ added: 2, removed: 1 });
  });

  it("marks lines that share no word whole, never as word soup", () => {
    const rows = lineDiff("alpha beta", "gamma delta");
    expect(rows).toEqual([
      { op: "del", text: "alpha beta", oldNo: 1 },
      { op: "add", text: "gamma delta", newNo: 1 },
    ]);
  });

  it("loses no line: every line of both sides is in the rows", () => {
    const before = ["x", "1", "2", "3", "y", "4"].join("\n");
    const after = ["1", "2", "z", "3", "4", "w"].join("\n");
    const rows = lineDiff(before, after);
    const old = rows.flatMap((r) => (r.op === "add" ? [] : [r.text]));
    const now = rows.flatMap((r) => (r.op === "del" ? [] : [r.text]));
    expect(old.join("\n")).toBe(before);
    expect(now.join("\n")).toBe(after);
  });
});

describe("foldUnchanged — the far unchanged rows fold, nothing is dropped", () => {
  const same = (r: string) => r === "=";
  it("keeps context around each change and folds the rest", () => {
    const rows = ["=", "=", "=", "=", "+", "=", "=", "=", "="];
    const out = foldUnchanged(rows, same, 1);
    expect(
      out.map((f) => (f.kind === "fold" ? `fold${f.rows.length}` : f.row))
    ).toEqual(["fold3", "=", "+", "=", "fold3"]);
    // Every row is still there, in order.
    const back = out.flatMap((f) => (f.kind === "fold" ? f.rows : [f.row]));
    expect(back).toEqual(rows);
  });

  it("never folds a single row behind a control", () => {
    const out = foldUnchanged(["=", "=", "+", "=", "="], same, 1);
    expect(out.every((f) => f.kind === "row")).toBe(true);
  });
});
