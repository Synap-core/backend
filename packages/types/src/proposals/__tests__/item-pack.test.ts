import { describe, it, expect } from "vitest";
import {
  readItemPackRefs,
  readUpdatePackItems,
  tallyItemPack,
} from "../item-pack.js";

const item = (ref: string) => ({
  ref,
  id: ref,
  subject: { kind: "note", name: ref },
  patch: { title: "x" },
  before: { title: ref },
});

/** An update pack as the gate stores it: inside the request-shaped envelope. */
const stored = {
  changeType: "update_pack",
  data: { schema: 1, batchId: "b", items: [item("a"), item("b"), { ref: 3 }] },
  dispositions: { b: { status: "reject" } },
  outcomes: {
    a: { outcome: "applied", at: "2026-10-13T00:00:00Z" },
    b: { outcome: "skipped_by_reviewer", at: "2026-10-13T00:00:00Z" },
  },
};

describe("item pack model", () => {
  it("reads an update pack's items from the envelope and counts what it cannot read", () => {
    const read = readUpdatePackItems(stored);
    expect(read.batchId).toBe("b");
    expect(read.items.map((i) => i.ref)).toEqual(["a", "b"]);
    expect(read.unreadable).toBe(1);
  });

  it("names the refs a per-item door may act on — cleanup (top level) and update (nested)", () => {
    expect(readItemPackRefs(stored)).toEqual(["a", "b"]);
    expect(readItemPackRefs({ items: [{ ref: "close_session:1" }] })).toEqual([
      "close_session:1",
    ]);
    // A plain proposal whose nested data has items is not a pack.
    expect(readItemPackRefs({ data: { items: [{ ref: "x" }] } })).toEqual([]);
    // A join's kept writes are its items.
    expect(
      readItemPackRefs({ deferredWrites: [{ ref: "dw1" }, { ref: "dw2" }] })
    ).toEqual(["dw1", "dw2"]);
  });

  it("tallies rejected, to-apply and recorded outcomes", () => {
    expect(tallyItemPack(stored, ["a", "b"])).toEqual({
      total: 2,
      rejected: 1,
      toApply: 1,
      applied: 1,
      refused: 0,
    });
  });
});
