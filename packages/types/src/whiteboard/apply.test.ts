import { describe, expect, it } from "vitest";
import {
  BoardApplyError,
  BOARD_PLACE_MAX_NEW_CELLS,
  BOARD_HTML_MAX_CHARS,
  PlaceOnBoardRequestSchema,
  approvedPlacementRecords,
  isPendingPlacement,
  pendingPlacementRootIds,
  planBoardApply,
  readPlacedBy,
  shapeDescendantIds,
  shapeRemovalIds,
  type BoardRecord,
} from "./index.js";

const AGENT = { userId: "u-1", agentUserId: "agent-1" };
const OTHER_AGENT = { userId: "u-1", agentUserId: "agent-2" };

function shape(
  id: string,
  over: Partial<BoardRecord> & { props?: Record<string, unknown> } = {}
): BoardRecord {
  return {
    id,
    typeName: "shape",
    type: "geo",
    x: 0,
    y: 0,
    rotation: 0,
    index: "a1",
    parentId: "page:p1",
    isLocked: false,
    opacity: 1,
    props: { w: 100, h: 50, text: "hi", count: 1 },
    meta: {},
    ...over,
  };
}
const pending = (by = AGENT) => ({ pending: true, placedBy: by });
const board = (...recs: BoardRecord[]) =>
  Object.fromEntries(recs.map((r) => [r.id, r]));

describe("planBoardApply: create", () => {
  it("writes a new shape", () => {
    const plan = planBoardApply({}, { create: [shape("shape:a")] });
    expect(plan.created).toEqual(["shape:a"]);
    expect(plan.skipped).toEqual([]);
  });

  it("replaces a shape the same agent placed that is still pending (a retry)", () => {
    const current = board(shape("shape:a", { meta: pending() }));
    const plan = planBoardApply(current, {
      create: [shape("shape:a", { x: 50, meta: pending() })],
    });
    expect(plan.created).toEqual(["shape:a"]);
    expect(plan.put[0]).toMatchObject({ x: 50 });
  });

  it("NEVER resets a shape the person kept (pending dropped) or moved", () => {
    const current = board(shape("shape:a", { x: 900, meta: {} }));
    const plan = planBoardApply(current, {
      create: [shape("shape:a", { x: 0, meta: pending() })],
    });
    expect(plan.created).toEqual([]);
    expect(plan.skipped).toEqual(["shape:a"]);
    expect(plan.put).toEqual([]);
  });

  it("another agent never overwrites a pending shape it did not place", () => {
    const current = board(shape("shape:a", { meta: pending(AGENT) }));
    const plan = planBoardApply(current, {
      create: [shape("shape:a", { meta: pending(OTHER_AGENT) })],
    });
    expect(plan.skipped).toEqual(["shape:a"]);
  });

  it("a person's shape under the same id is not replaced", () => {
    const current = board(shape("shape:a", { meta: { placedBy: AGENT } }));
    expect(
      planBoardApply(current, {
        create: [shape("shape:a", { meta: pending() })],
      }).skipped
    ).toEqual(["shape:a"]);
  });

  it("a page that exists stays; the children of a skipped shape are skipped with it", () => {
    const current = board(
      { id: "page:p1", typeName: "page", name: "P", index: "a1", meta: {} },
      shape("shape:ab", { meta: {} })
    );
    const plan = planBoardApply(current, {
      create: [
        { id: "page:p1", typeName: "page", name: "New", index: "a1", meta: {} },
        shape("shape:ab", { meta: pending() }),
        shape("shape:cell", { parentId: "shape:ab", meta: pending() }),
      ],
    });
    expect(plan.created).toEqual([]);
    expect(plan.skipped.sort()).toEqual(
      ["page:p1", "shape:ab", "shape:cell"].sort()
    );
  });
});

describe("planBoardApply: patch (against the board as it is NOW)", () => {
  it("merges into the live record: a person's other edits survive", () => {
    const current = board(
      shape("shape:a", {
        x: 7,
        props: { w: 100, h: 50, text: "typed by a person" },
      })
    );
    const plan = planBoardApply(current, {
      patch: [{ shapeId: "shape:a", x: 10, w: 222 }],
    });
    expect(plan.put[0]).toMatchObject({
      x: 10,
      props: { w: 222, h: 50, text: "typed by a person" },
    });
  });

  it("refuses a shape the board does not hold, writing nothing", () => {
    expect(() =>
      planBoardApply(board(shape("shape:a")), {
        patch: [{ shapeId: "shape:nope", x: 1 }],
        create: [shape("shape:b")],
      })
    ).toThrow(BoardApplyError);
  });

  it("refuses a prop the shape does not have, or of another type", () => {
    const current = board(shape("shape:a"));
    expect(() =>
      planBoardApply(current, {
        patch: [{ shapeId: "shape:a", props: { bogus: 1 } }],
      })
    ).toThrow(/no prop "bogus"/);
    expect(() =>
      planBoardApply(current, {
        patch: [{ shapeId: "shape:a", props: { count: "one" } }],
      })
    ).toThrow(/is a number; got a string/);
  });

  it("refuses w/h on a shape that has none (an arrow, a draw shape)", () => {
    const current = board(shape("shape:arrow", { props: { color: "red" } }));
    expect(() =>
      planBoardApply(current, { patch: [{ shapeId: "shape:arrow", w: 5 }] })
    ).toThrow(/no prop "w"/);
  });

  it("never patches a reference prop", () => {
    const current = board(
      shape("shape:e", { props: { entityId: "x", title: "t" } })
    );
    expect(() =>
      planBoardApply(current, {
        patch: [{ shapeId: "shape:e", props: { entityId: "y" } }],
      })
    ).toThrow(/cannot be changed/);
  });

  it("a shape removed in the same call is not also patched", () => {
    const current = board(shape("shape:a"));
    const plan = planBoardApply(current, {
      patch: [{ shapeId: "shape:a", x: 1 }],
      remove: ["shape:a"],
    });
    expect(plan.put).toEqual([]);
    expect(plan.delete).toEqual(["shape:a"]);
  });
});

describe("planBoardApply: remove (closure from the live map)", () => {
  it("takes a child or an arrow binding added since the API read", () => {
    const current = board(
      shape("shape:frame", { type: "frame" }),
      shape("shape:late-child", { parentId: "shape:frame" }),
      {
        id: "binding:late",
        typeName: "binding",
        fromId: "shape:arrow",
        toId: "shape:late-child",
      } as BoardRecord
    );
    const plan = planBoardApply(current, { remove: ["shape:frame"] });
    expect(plan.delete.sort()).toEqual(
      ["binding:late", "shape:frame", "shape:late-child"].sort()
    );
  });

  it("refuses an unknown shape", () => {
    expect(() =>
      planBoardApply(board(shape("shape:a")), { remove: ["shape:nope"] })
    ).toThrow(/holds no shape shape:nope/);
  });
});

describe("the pending marks and the tree", () => {
  const recs = board(
    shape("shape:deck", { meta: pending() }),
    shape("shape:slide", { parentId: "shape:deck", meta: pending() }),
    shape("shape:kept", { meta: { placedBy: AGENT } }),
    shape("shape:other-pending", { meta: pending(OTHER_AGENT) })
  );

  it("isPendingPlacement is true only for meta.pending === true", () => {
    expect(isPendingPlacement({ meta: { pending: true } })).toBe(true);
    expect(isPendingPlacement({ meta: { pending: "true" } })).toBe(false);
    expect(isPendingPlacement({ meta: {} })).toBe(false);
    expect(isPendingPlacement({})).toBe(false);
  });

  it("readPlacedBy parses the mark and is null when malformed", () => {
    expect(readPlacedBy({ meta: { placedBy: AGENT } })).toEqual(AGENT);
    expect(
      readPlacedBy({ meta: { placedBy: { agentUserId: "a" } } })
    ).toBeNull();
    expect(readPlacedBy({ meta: {} })).toBeNull();
    expect(
      readPlacedBy({ meta: { placedBy: { userId: "u", proposalId: 3 } } })
    ).toEqual({ userId: "u" });
  });

  it("shapeDescendantIds is the shapes plus everything they hold", () => {
    expect(shapeDescendantIds(recs, ["shape:deck"]).sort()).toEqual([
      "shape:deck",
      "shape:slide",
    ]);
    expect(shapeDescendantIds(recs, ["shape:nope"])).toEqual([]);
  });

  it("shapeRemovalIds walks the same tree", () => {
    expect(shapeRemovalIds(recs, ["shape:deck"]).ids.sort()).toEqual([
      "shape:deck",
      "shape:slide",
    ]);
  });

  it("pendingPlacementRootIds: an artboard and its slide are ONE decision", () => {
    expect(pendingPlacementRootIds(recs).sort()).toEqual([
      "shape:deck",
      "shape:other-pending",
    ]);
  });

  it("approvedPlacementRecords drops meta.pending, keeps placedBy, only for pending shapes", () => {
    const out = approvedPlacementRecords(recs, ["shape:deck", "shape:kept"]);
    expect(out.map((r) => r.id).sort()).toEqual(["shape:deck", "shape:slide"]);
    for (const r of out) {
      expect(isPendingPlacement(r)).toBe(false);
      expect(readPlacedBy(r)).toEqual(AGENT);
    }
  });
});

describe("PlaceOnBoardRequestSchema bounds (checked before any cell is made)", () => {
  const deck = (n: number) => ({
    kind: "artboard-deck" as const,
    preset: "slide-16-9",
    slides: Array.from({ length: n }, () => ({ html: "<p/>" })),
  });

  it("refuses a call that would create more cells than the cap (50 decks of 50 slides)", () => {
    const parsed = PlaceOnBoardRequestSchema.safeParse({
      resources: Array.from({ length: 50 }, () => deck(50)),
    });
    expect(parsed.success).toBe(false);
  });

  it("the cap holds at its edge: 100 cells pass, 101 do not", () => {
    expect(
      PlaceOnBoardRequestSchema.safeParse({ resources: [deck(50), deck(50)] })
        .success
    ).toBe(true);
    expect(
      PlaceOnBoardRequestSchema.safeParse({
        resources: [deck(50), deck(50), deck(1)],
      }).success
    ).toBe(false);
    expect(BOARD_PLACE_MAX_NEW_CELLS).toBe(100);
  });

  it("refuses html over the cap and props over the cap", () => {
    expect(
      PlaceOnBoardRequestSchema.safeParse({
        resources: [
          {
            kind: "html",
            name: "x",
            html: "a".repeat(BOARD_HTML_MAX_CHARS + 1),
          },
        ],
      }).success
    ).toBe(false);
    expect(
      PlaceOnBoardRequestSchema.safeParse({
        resources: [
          {
            kind: "cellDefinition",
            cellKey: "k",
            props: { big: "a".repeat(30_000) },
          },
        ],
      }).success
    ).toBe(false);
  });

  it("refuses an update that points a shape at something else", () => {
    expect(
      PlaceOnBoardRequestSchema.safeParse({
        update: [{ shapeId: "shape:a", props: { entityId: "x" } }],
      }).success
    ).toBe(false);
    expect(
      PlaceOnBoardRequestSchema.safeParse({
        update: [{ shapeId: "shape:a", props: { text: "x" } }],
      }).success
    ).toBe(true);
  });
});
