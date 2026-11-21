/**
 * The ops an agent changes a design with: applied in order on a copy, every
 * block held to the one validator, all or nothing, and a refusal that names
 * the op, the reason and the catalog hash.
 */
import { describe, expect, it } from "vitest";
import {
  BOARD_FORMAT,
  LEGACY_BOARD_FORMAT,
  emptyBoard,
  type Board,
  type PageBlock,
} from "./board.js";
import type { DesignCatalogSnapshot } from "./catalog.js";
import { applyOps, describeRefusal } from "./ops.js";

const catalog: DesignCatalogSnapshot = {
  kitId: "synap",
  hash: "h-test",
  components: {
    SpatialButton: {
      variant: { kind: "select", options: ["primary", "secondary"] },
      label: { kind: "slot", allow: ["Text"] },
    },
  },
  layout: {
    Section: { children: { kind: "slot" } },
    Stack: {
      gap: { kind: "select", options: ["space-100", "space-200"] },
      children: { kind: "slot" },
    },
    // Two slots (`start` is a grid prop every block has, so not a slot name).
    Split: { lead: { kind: "slot" }, end: { kind: "slot" } },
    Text: { text: { kind: "text" } },
  },
};

const ok = (r: ReturnType<typeof applyOps>) => {
  if (!r.ok) throw new Error(r.message);
  return r;
};
const blocksOf = (board: Board, frame = 0) => board.frames[frame]!.page.content;
const kids = (b: PageBlock, prop = "children") => b.props[prop] as PageBlock[];

/** A board with one desktop frame holding a Section with a Stack in it. */
function seeded(): Board {
  return ok(
    applyOps(
      emptyBoard(),
      [
        { op: "add_frame", preset: "desktop", id: "d" },
        {
          op: "add_block",
          frameId: "d",
          type: "Section",
          props: { id: "sec" },
        },
        {
          op: "add_block",
          frameId: "d",
          parentId: "sec",
          type: "Stack",
          props: { id: "st", gap: "space-100" },
        },
      ],
      catalog
    )
  ).board;
}

describe("applyOps: a batch builds on itself", () => {
  it("a frame, then blocks that name the ids earlier ops gave; changes are listed per op", () => {
    const r = ok(
      applyOps(
        emptyBoard(),
        [
          { op: "add_frame", preset: "desktop", id: "d" },
          {
            op: "add_block",
            frameId: "d",
            type: "Section",
            props: { id: "sec" },
          },
          {
            op: "add_block",
            frameId: "d",
            parentId: "sec",
            type: "Text",
            props: { text: "Hi" },
          },
          {
            op: "add_block",
            frameId: "d",
            parentId: "sec",
            index: 0,
            type: "SpatialButton",
            props: { variant: "primary" },
          },
        ],
        catalog
      )
    );
    const sec = blocksOf(r.board)[0]!;
    expect(kids(sec).map((b) => [b.type, b.props.id])).toEqual([
      ["SpatialButton", "SpatialButton-1"],
      ["Text", "Text-1"],
    ]);
    expect(r.changes.map((c) => [c.opIndex, c.change])).toEqual([
      [0, "frame-added"],
      [1, "block-added"],
      [2, "block-added"],
      [3, "block-added"],
    ]);
    expect(r.componentsUsed).toEqual(["Section", "SpatialButton", "Text"]);
    expect(r.catalogHash).toBe("h-test");
  });

  it("a new frame sits right of the rightmost one, sized by its preset", () => {
    const r = ok(
      applyOps(seeded(), [{ op: "add_frame", preset: "phone" }], catalog)
    );
    expect(r.board.frames[1]).toMatchObject({
      id: "phone",
      x: 1440 + 160,
      y: 0,
      w: 390,
      h: 844,
    });
  });
});

describe("applyOps: all or nothing, and the refusal says why", () => {
  it("an unknown component refuses the batch: op index, the validator's reason, the catalog hash; the board is untouched", () => {
    const before = seeded();
    const copy = JSON.stringify(before);
    const r = applyOps(
      before,
      [
        {
          op: "add_block",
          frameId: "d",
          parentId: "st",
          type: "Text",
          props: { text: "kept?" },
        },
        { op: "add_block", frameId: "d", parentId: "st", type: "Carousel" },
      ],
      catalog
    );
    expect(r).toMatchObject({
      ok: false,
      opIndex: 1,
      op: "add_block",
      reasons: [{ kind: "unknown-type", type: "Carousel" }],
      catalogHash: "h-test",
    });
    if (r.ok) return;
    expect(r.message).toContain("synap@h-test");
    expect(r.message).toContain("Carousel");
    expect(JSON.stringify(before)).toBe(copy);
  });

  it("a prop value that is not one of its options (a token step) is refused", () => {
    const r = applyOps(
      seeded(),
      [{ op: "update_block", id: "st", props: { gap: "16px" } }],
      catalog
    );
    expect(r).toMatchObject({
      ok: false,
      reasons: [{ kind: "bad-prop", type: "Stack", prop: "gap" }],
    });
  });

  it("a slot takes only the types it allows", () => {
    const b = ok(
      applyOps(
        seeded(),
        [
          {
            op: "add_block",
            frameId: "d",
            parentId: "st",
            type: "SpatialButton",
            props: { id: "btn" },
          },
        ],
        catalog
      )
    ).board;
    const r = applyOps(
      b,
      [
        {
          op: "add_block",
          frameId: "d",
          parentId: "btn",
          slot: "label",
          type: "Stack",
        },
      ],
      catalog
    );
    expect(r).toMatchObject({
      ok: false,
      reasons: [
        {
          kind: "not-allowed",
          type: "Stack",
          parent: "SpatialButton",
          prop: "label",
        },
      ],
    });
  });

  it("a malformed op, an unknown op and an undeclared field are refused as bad-op", () => {
    expect(
      applyOps(seeded(), [{ op: "add_block", frameId: "d" }], catalog)
    ).toMatchObject({ ok: false, reasons: [{ kind: "bad-op" }] });
    expect(applyOps(seeded(), [{ op: "paint" }], catalog)).toMatchObject({
      ok: false,
      op: "paint",
      reasons: [{ kind: "bad-op" }],
    });
    expect(
      applyOps(
        seeded(),
        [{ op: "remove_block", id: "st", force: true }],
        catalog
      )
    ).toMatchObject({ ok: false, reasons: [{ kind: "bad-op" }] });
  });

  it("create_design is the door's, never a board op", () => {
    expect(
      applyOps(emptyBoard(), [{ op: "create_design", title: "X" }], catalog)
    ).toMatchObject({
      ok: false,
      reasons: [{ kind: "create-not-first" }],
    });
  });

  it("an id already used, a missing block or frame, a parent with no single slot, an index past the end", () => {
    const b = seeded();
    expect(
      applyOps(
        b,
        [{ op: "add_block", frameId: "d", type: "Text", props: { id: "st" } }],
        catalog
      )
    ).toMatchObject({
      ok: false,
      reasons: [{ kind: "duplicate-id", id: "st" }],
    });
    expect(
      applyOps(b, [{ op: "remove_block", id: "nope" }], catalog)
    ).toMatchObject({ ok: false, reasons: [{ kind: "no-block", id: "nope" }] });
    expect(
      applyOps(b, [{ op: "add_block", frameId: "x", type: "Text" }], catalog)
    ).toMatchObject({
      ok: false,
      reasons: [{ kind: "no-frame", frameId: "x" }],
    });
    const split = ok(
      applyOps(
        b,
        [{ op: "add_block", frameId: "d", type: "Split", props: { id: "sp" } }],
        catalog
      )
    ).board;
    expect(
      applyOps(
        split,
        [{ op: "add_block", frameId: "d", parentId: "sp", type: "Text" }],
        catalog
      )
    ).toMatchObject({
      ok: false,
      reasons: [{ kind: "bad-slot", type: "Split", prop: null }],
    });
    expect(
      applyOps(
        b,
        [{ op: "add_block", frameId: "d", index: 5, type: "Text" }],
        catalog
      )
    ).toMatchObject({
      ok: false,
      reasons: [{ kind: "bad-index", index: 5, length: 1 }],
    });
  });

  it("every reason has words", () => {
    const r = applyOps(
      seeded(),
      [{ op: "set_span", id: "st", class: "expanded", span: 13 }],
      catalog
    );
    if (r.ok) throw new Error("expected a refusal");
    expect(r.reasons.map(describeRefusal)).toEqual([
      "a span at the expanded width is a whole number from 1 to 12 columns, not 13",
    ]);
  });
});

describe("applyOps: blocks", () => {
  it("update_block sets and unsets props; id and type never change", () => {
    const r = ok(
      applyOps(
        seeded(),
        [{ op: "update_block", id: "st", props: { gap: "space-200" } }],
        catalog
      )
    );
    expect(kids(blocksOf(r.board)[0]!)[0]!.props.gap).toBe("space-200");
    const u = ok(
      applyOps(
        r.board,
        [{ op: "update_block", id: "st", unset: ["gap"] }],
        catalog
      )
    );
    expect(kids(blocksOf(u.board)[0]!)[0]!.props).not.toHaveProperty("gap");
    expect(
      applyOps(
        seeded(),
        [{ op: "update_block", id: "st", props: { type: "Text" } }],
        catalog
      )
    ).toMatchObject({
      ok: false,
      reasons: [{ kind: "fixed-prop", prop: "type" }],
    });
  });

  it("move_block carries its children to another slot; never into itself", () => {
    const b = ok(
      applyOps(
        seeded(),
        [
          {
            op: "add_block",
            frameId: "d",
            parentId: "st",
            type: "Text",
            props: { id: "t", text: "a" },
          },
          {
            op: "add_block",
            frameId: "d",
            type: "Section",
            props: { id: "sec2" },
          },
        ],
        catalog
      )
    ).board;
    const moved = ok(
      applyOps(b, [{ op: "move_block", id: "st", parentId: "sec2" }], catalog)
    ).board;
    expect(kids(blocksOf(moved)[0]!)).toEqual([]);
    expect(kids(blocksOf(moved)[1]!).map((x) => x.props.id)).toEqual(["st"]);
    expect(kids(kids(blocksOf(moved)[1]!)[0]!).map((x) => x.props.id)).toEqual([
      "t",
    ]);
    expect(
      applyOps(b, [{ op: "move_block", id: "sec", parentId: "st" }], catalog)
    ).toMatchObject({
      ok: false,
      reasons: [{ kind: "into-itself", id: "sec" }],
    });
  });

  it("remove_block takes its children with it", () => {
    const r = ok(
      applyOps(seeded(), [{ op: "remove_block", id: "sec" }], catalog)
    );
    expect(blocksOf(r.board)).toEqual([]);
  });

  it("set_span keeps a whole number of the class's columns, null clears it; set_hide stores only where it hides", () => {
    const r = ok(
      applyOps(
        seeded(),
        [
          { op: "set_span", id: "st", class: "expanded", span: 6 },
          { op: "set_span", id: "st", class: "compact", span: 4 },
          { op: "set_span", id: "st", class: "compact", span: null },
          { op: "set_hide", id: "st", class: "compact", hide: true },
          { op: "set_hide", id: "st", class: "medium", hide: false },
        ],
        catalog
      )
    );
    expect(kids(blocksOf(r.board)[0]!)[0]!.props).toMatchObject({
      span: { expanded: 6 },
      hide: { compact: true },
    });
    expect(
      applyOps(
        seeded(),
        [{ op: "set_span", id: "st", class: "compact", span: 5 }],
        catalog
      )
    ).toMatchObject({
      ok: false,
      reasons: [
        { kind: "span-too-wide", class: "compact", span: 5, columns: 4 },
      ],
    });
  });

  it("set_start places a block at a column of one class, kept with its span; null gives it back to the grid", () => {
    const r = ok(
      applyOps(
        seeded(),
        [
          { op: "set_span", id: "st", class: "expanded", span: 4 },
          { op: "set_start", id: "st", class: "expanded", start: 9 },
          { op: "set_start", id: "st", class: "compact", start: 4 },
          { op: "set_start", id: "st", class: "medium", start: 3 },
          { op: "set_start", id: "st", class: "medium", start: null },
        ],
        catalog
      )
    );
    expect(kids(blocksOf(r.board)[0]!)[0]!.props).toMatchObject({
      span: { expanded: 4 },
      start: { expanded: 9, compact: 4 },
    });
    expect(kids(blocksOf(r.board)[0]!)[0]!.props.start).toEqual({
      expanded: 9,
      compact: 4,
    });
    const cleared = ok(
      applyOps(
        r.board,
        [
          { op: "set_start", id: "st", class: "expanded", start: null },
          { op: "set_start", id: "st", class: "compact", start: null },
        ],
        catalog
      )
    );
    expect(kids(blocksOf(cleared.board)[0]!)[0]!.props).not.toHaveProperty(
      "start"
    );
  });

  it("a start and a span that run past the class's columns are refused, from either op, and named", () => {
    const placed = ok(
      applyOps(
        seeded(),
        [
          { op: "set_span", id: "st", class: "expanded", span: 4 },
          { op: "set_start", id: "st", class: "expanded", start: 9 },
        ],
        catalog
      )
    ).board;
    const startPast = applyOps(
      placed,
      [{ op: "set_start", id: "st", class: "expanded", start: 10 }],
      catalog
    );
    expect(startPast).toMatchObject({
      ok: false,
      reasons: [
        {
          kind: "start-past-grid",
          class: "expanded",
          start: 10,
          span: 4,
          columns: 12,
        },
      ],
    });
    const spanPast = applyOps(
      placed,
      [{ op: "set_span", id: "st", class: "expanded", span: 5 }],
      catalog
    );
    expect(spanPast).toMatchObject({
      ok: false,
      reasons: [
        {
          kind: "start-past-grid",
          class: "expanded",
          start: 9,
          span: 5,
          columns: 12,
        },
      ],
    });
    const noColumn = applyOps(
      seeded(),
      [{ op: "set_start", id: "st", class: "compact", start: 5 }],
      catalog
    );
    if (noColumn.ok || spanPast.ok) throw new Error("expected refusals");
    expect(noColumn.reasons.map(describeRefusal)).toEqual([
      "a start at the compact width is a column from 1 to 4, not 5",
    ]);
    expect(spanPast.reasons.map(describeRefusal)).toEqual([
      "at the expanded width a block starting at column 9 and spanning 5 ends past column 12: lower the start or the span (set_span) first",
    ]);
  });
});

describe("applyOps: frames and pages", () => {
  it("a viewport frame shows another frame's page; a block added through it lands in that page", () => {
    const r = ok(
      applyOps(
        seeded(),
        [
          { op: "add_frame", preset: "tablet", pageOf: "d" },
          {
            op: "add_block",
            frameId: "tablet",
            parentId: null,
            type: "Text",
            props: { text: "x" },
          },
        ],
        catalog
      )
    );
    expect(r.board.frames[1]).toMatchObject({
      id: "tablet",
      pageOf: "d",
      w: 834,
    });
    expect(r.board.frames[1]!.page.content).toEqual([]);
    expect(blocksOf(r.board).map((b) => b.type)).toEqual(["Section", "Text"]);
    expect(r.changes[1]).toMatchObject({ change: "block-added", frameId: "d" });
  });

  it("a frame shown by another cannot go first; a viewer cannot show a viewer", () => {
    const b = ok(
      applyOps(
        seeded(),
        [{ op: "add_frame", preset: "tablet", pageOf: "d" }],
        catalog
      )
    ).board;
    expect(
      applyOps(b, [{ op: "remove_frame", frameId: "d" }], catalog)
    ).toMatchObject({
      ok: false,
      reasons: [
        { kind: "frame-has-viewers", frameId: "d", viewers: ["tablet"] },
      ],
    });
    expect(
      applyOps(
        b,
        [{ op: "add_frame", preset: "phone", pageOf: "tablet" }],
        catalog
      )
    ).toMatchObject({
      ok: false,
      reasons: [{ kind: "bad-page-of" }],
    });
    expect(
      applyOps(b, [{ op: "add_frame", preset: "watch" }], catalog)
    ).toMatchObject({
      ok: false,
      reasons: [{ kind: "bad-preset", preset: "watch" }],
    });
  });

  it("replace_page checks the page, gives missing ids, refuses an id another frame holds and a viewer frame", () => {
    const b = ok(
      applyOps(
        seeded(),
        [
          { op: "add_frame", preset: "phone", id: "p" },
          { op: "add_frame", preset: "tablet", id: "t", pageOf: "d" },
        ],
        catalog
      )
    ).board;
    const page = {
      root: { props: {} },
      content: [{ type: "Text", props: { text: "a" } }],
    };
    const r = ok(
      applyOps(b, [{ op: "replace_page", frameId: "p", page }], catalog)
    );
    expect(r.board.frames[1]!.page.content[0]!.props.id).toBe("Text-1");
    expect(
      applyOps(
        b,
        [
          {
            op: "replace_page",
            frameId: "p",
            page: { content: [{ type: "Text", props: { id: "sec" } }] },
          },
        ],
        catalog
      )
    ).toMatchObject({
      ok: false,
      reasons: [{ kind: "duplicate-id", id: "sec" }],
    });
    expect(
      applyOps(b, [{ op: "replace_page", frameId: "t", page }], catalog)
    ).toMatchObject({
      ok: false,
      reasons: [{ kind: "frame-shows-page", frameId: "t", pageOf: "d" }],
    });
    expect(
      applyOps(
        b,
        [
          {
            op: "replace_page",
            frameId: "p",
            page: { content: [{ type: "Nope", props: {} }] },
          },
        ],
        catalog
      )
    ).toMatchObject({
      ok: false,
      reasons: [{ kind: "unknown-type", type: "Nope" }],
    });
  });

  it("replace_board takes a clean v3 board; anything the parser would drop, or an older format, is refused", () => {
    const board = seeded();
    expect(
      ok(applyOps(emptyBoard(), [{ op: "replace_board", board }], catalog))
        .board
    ).toEqual(board);
    const dirty = {
      format: BOARD_FORMAT,
      frames: [
        {
          ...board.frames[0]!,
          page: { root: { props: {} }, content: [{ type: "Nope", props: {} }] },
        },
      ],
    };
    expect(
      applyOps(emptyBoard(), [{ op: "replace_board", board: dirty }], catalog)
    ).toMatchObject({
      ok: false,
      reasons: [{ kind: "unknown-type", type: "Nope" }],
    });
    expect(
      applyOps(
        emptyBoard(),
        [
          {
            op: "replace_board",
            board: { format: LEGACY_BOARD_FORMAT, frames: [], items: [] },
          },
        ],
        catalog
      )
    ).toMatchObject({ ok: false, reasons: [{ kind: "not-v3" }] });
  });
});
