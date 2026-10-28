/**
 * A graph's records capped per kind. Rows that rule out a wrong rule: kinds
 * interleaved in the graph (a cap over the whole list would hide one kind
 * entirely); a record owing a choice past the cap (folding it would send a
 * choice nobody made).
 */
import { describe, expect, it } from "vitest";
import { recordGroups, RECORDS_SHOWN_PER_KIND } from "./record-groups";

type R = { ref: string; kind: string | null };
const rec = (ref: string, kind: string | null): R => ({ ref, kind });

describe("recordGroups", () => {
  it("one group per kind, first appearance first, each capped", () => {
    const records = [
      ...Array.from({ length: 8 }, (_, i) => rec(`p${i}`, "person")),
      rec("c0", "company"),
      rec("p8", "person"),
    ];
    const groups = recordGroups(records, () => false);
    expect(groups.map((g) => [g.kind, g.all.length, g.shown.length])).toEqual([
      ["person", 9, RECORDS_SHOWN_PER_KIND],
      ["company", 1, 1],
    ]);
    expect(groups[0]!.shown.map((r) => r.ref)).toEqual([
      "p0",
      "p1",
      "p2",
      "p3",
      "p4",
    ]);
  });

  it("what may never fold is shown past the cap, in its place", () => {
    const records = Array.from({ length: 9 }, (_, i) => rec(`p${i}`, "person"));
    const groups = recordGroups(records, (r) => r.ref === "p7");
    expect(groups[0]!.shown.map((r) => r.ref)).toEqual([
      "p0",
      "p1",
      "p2",
      "p3",
      "p4",
      "p7",
    ]);
  });

  it("a short list is never capped", () => {
    const records = [rec("s0", "skill"), rec("s1", "skill")];
    expect(recordGroups(records, () => false)[0]!.shown).toHaveLength(2);
  });
});
