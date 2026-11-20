/**
 * The board parser, moved with its tests from app-bases
 * `apps/ui-gallery/src/design/__tests__/board.test.ts` (the store tests, which
 * read through the app's pod client, stay in app-bases).
 */
import { describe, expect, it } from "vitest";
import {
  BOARD_FORMAT,
  LEGACY_BOARD_FORMAT,
  MAX_DEPTH,
  boardComponents,
  childLists,
  nextBlockId,
  pageOwner,
  parseBoard,
  reIdBlocks,
  walkBlocks,
  type PageBlock,
} from "./board.js";
import type { CanvasSchema } from "./schema.js";

const schema: CanvasSchema = {
  SpatialButton: {
    children: { kind: "slot" },
    variant: { kind: "select", options: ["primary"] },
  },
  Heading: { text: { kind: "text" } },
  Text: { text: { kind: "text" } },
  Stack: { children: { kind: "slot" } },
};

const raw = {
  format: BOARD_FORMAT,
  frames: [
    {
      id: "f1",
      name: "Home",
      x: 0,
      y: 0,
      w: 1440,
      h: 900,
      page: {
        root: { props: {} },
        content: [
          {
            type: "Stack",
            props: {
              id: "s1",
              children: [
                { type: "Heading", props: { id: "h1", text: "Hi" } },
                { type: "NotInCatalog", props: { id: "x" } },
                {
                  type: "SpatialButton",
                  props: {
                    id: "b1",
                    children: [{ type: "Text", props: { text: "Go" } }],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
};

const ids = (list: PageBlock[]): string[] =>
  list.flatMap((b) => [
    b.props.id,
    ...Object.values(b.props).flatMap((v) =>
      Array.isArray(v) ? ids(v as PageBlock[]) : []
    ),
  ]);

describe("parseBoard (v3)", () => {
  it("reads a v3 board an agent wrote as a JSON string; unknown types are dropped inside a slot and named", () => {
    const r = parseBoard(JSON.stringify(raw), schema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migrated).toBe(false);
    expect(r.dropped).toEqual([{ kind: "unknown-type", type: "NotInCatalog" }]);
    const stack = r.board.frames[0]!.page.content[0]!;
    const kids = stack.props.children as PageBlock[];
    expect(kids.map((k) => k.type)).toEqual(["Heading", "SpatialButton"]);
  });

  it("keeps a frame key it does not know, through parse (a save must not erase a field a newer writer added)", () => {
    const withExtra = {
      format: BOARD_FORMAT,
      frames: [
        {
          id: "f",
          name: "F",
          x: 1,
          y: 2,
          w: 300,
          h: 400,
          stories: { a: "s1" },
          grid: "12",
          page: { root: { props: {} }, content: [] },
        },
      ],
    };
    const r = parseBoard(withExtra, schema);
    if (!r.ok) throw new Error("fixture");
    expect(r.board.frames[0]).toMatchObject({
      stories: { a: "s1" },
      grid: "12",
      id: "f",
      w: 300,
    });
  });

  it("fills missing ids deterministically, unique in the board, and renames a repeated one", () => {
    const dup = {
      format: BOARD_FORMAT,
      frames: [
        {
          id: "f",
          name: "F",
          x: 0,
          y: 0,
          w: 100,
          h: 100,
          page: {
            root: { props: {} },
            content: [
              { type: "Heading", props: { id: "a" } },
              { type: "Heading", props: { id: "a" } },
              { type: "Text", props: {} },
              {
                type: "Stack",
                props: {
                  id: "Text-1",
                  children: [{ type: "Text", props: {} }],
                },
              },
            ],
          },
        },
      ],
    };
    const r = parseBoard(dup, schema);
    if (!r.ok) throw new Error("fixture");
    const all = ids(r.board.frames[0]!.page.content);
    expect(new Set(all).size).toBe(all.length);
    expect(all.every((i) => typeof i === "string" && i !== "")).toBe(true);
    // The explicit "Text-1" keeps its id; a generated one never takes it.
    expect(r.board.frames[0]!.page.content[3]!.props.id).toBe("Text-1");
    expect(JSON.stringify(parseBoard(dup, schema))).toBe(JSON.stringify(r));
  });

  it("refuses a non-design object and invalid JSON instead of opening an empty board", () => {
    expect(parseBoard({ foo: 1 }).ok).toBe(false);
    expect(parseBoard({ format: "other", content: [], root: {} }).ok).toBe(
      false
    );
    expect(parseBoard("{not json").ok).toBe(false);
  });

  it("refuses a frame whose page is not a page, never opens it empty", () => {
    const bad = {
      format: BOARD_FORMAT,
      frames: [
        { id: "f", name: "F", x: 0, y: 0, w: 10, h: 10, page: { nope: 1 } },
      ],
    };
    expect(parseBoard(bad).ok).toBe(false);
  });

  it("a frame with no page opens with an empty page", () => {
    const r = parseBoard({
      format: BOARD_FORMAT,
      frames: [{ id: "f", name: "F", x: 0, y: 0, w: 10, h: 10 }],
    });
    expect(r.ok && r.board.frames[0]!.page).toEqual({
      root: { props: {} },
      content: [],
    });
  });

  it("drops blocks under a prop the catalog does not list as a slot, and names them", () => {
    // A Divider's `children` is inherited from React only: not a slot, so blocks
    // saved there would never render and must not count as components used.
    const withDivider = {
      ...schema,
      Divider: { label: { kind: "text" } },
    } as CanvasSchema;
    const board = {
      format: BOARD_FORMAT,
      frames: [
        {
          id: "f",
          name: "F",
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          page: {
            root: { props: {} },
            content: [
              {
                type: "Divider",
                props: {
                  id: "d",
                  children: [
                    { type: "Heading", props: { id: "h", text: "x" } },
                  ],
                },
              },
            ],
          },
        },
      ],
    };
    const r = parseBoard(board, withDivider);
    if (!r.ok) throw new Error("fixture");
    expect(r.board.frames[0]!.page.content[0]!.props.children).toBeUndefined();
    expect(r.dropped).toEqual([
      { kind: "not-a-slot", type: "Divider", prop: "children" },
    ]);
    expect(boardComponents(r.board)).toEqual(["Divider"]);
  });

  it("lists the components used in every slot, sorted", () => {
    const r = parseBoard(raw, schema);
    expect(r.ok && boardComponents(r.board)).toEqual([
      "Heading",
      "SpatialButton",
      "Stack",
      "Text",
    ]);
  });
});

const frame = (
  id: string,
  content: unknown[],
  extra: Record<string, unknown> = {}
) => ({
  id,
  name: id,
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  page: { root: { props: {} }, content, ...extra },
});
const board = (...frames: unknown[]) => ({ format: BOARD_FORMAT, frames });

describe("parseBoard is the one validation door", () => {
  it("drops an undeclared prop and a value that does not fit (wrong kind, outside its options), and names each", () => {
    const r = parseBoard(
      board(
        frame("f", [
          {
            type: "SpatialButton",
            props: { id: "b", variant: "huge", className: "x", children: [] },
          },
          {
            type: "Heading",
            props: {
              id: "h",
              text: 3,
              dangerouslySetInnerHTML: { __html: "<img>" },
            },
          },
          { type: "Heading", props: { id: "ok", text: "Fine" } },
        ])
      ),
      schema
    );
    if (!r.ok) throw new Error(r.error);
    const [b, h, ok] = r.board.frames[0]!.page.content;
    expect(b!.props).toEqual({ id: "b", children: [] });
    expect(h!.props).toEqual({ id: "h" });
    expect(ok!.props).toEqual({ id: "ok", text: "Fine" });
    expect(r.dropped).toEqual([
      { kind: "bad-prop", type: "SpatialButton", prop: "variant" },
      { kind: "bad-prop", type: "SpatialButton", prop: "className" },
      { kind: "bad-prop", type: "Heading", prop: "text" },
      { kind: "bad-prop", type: "Heading", prop: "dangerouslySetInnerHTML" },
    ]);
  });

  it("an inherited name is not a component: `constructor` is dropped like any unknown type", () => {
    const r = parseBoard(
      board(frame("f", [{ type: "constructor", props: { id: "c" } }])),
      schema
    );
    expect(r.ok && r.dropped).toEqual([
      { kind: "unknown-type", type: "constructor" },
    ]);
    expect(r.ok && r.board.frames[0]!.page.content).toEqual([]);
  });

  it("a slot keeps only the types it allows (a label slot: inline blocks), and names the rest", () => {
    const labelled: CanvasSchema = {
      ...schema,
      SpatialButton: { children: { kind: "slot", allow: ["Text"] } },
    };
    const r = parseBoard(
      board(
        frame("f", [
          {
            type: "SpatialButton",
            props: {
              id: "b",
              children: [
                { type: "Text", props: { id: "t", text: "Go" } },
                { type: "Stack", props: { id: "s", children: [] } },
              ],
            },
          },
        ])
      ),
      labelled
    );
    if (!r.ok) throw new Error(r.error);
    const kids = r.board.frames[0]!.page.content[0]!.props
      .children as PageBlock[];
    expect(kids.map((k) => k.type)).toEqual(["Text"]);
    expect(r.dropped).toEqual([
      {
        kind: "not-allowed",
        type: "Stack",
        parent: "SpatialButton",
        prop: "children",
      },
    ]);
    // A slot with no `allow` takes any block.
    const open = parseBoard(
      board(
        frame("f", [
          {
            type: "Stack",
            props: {
              id: "s",
              children: [{ type: "Stack", props: { id: "s2" } }],
            },
          },
        ])
      ),
      labelled
    );
    expect(open.ok && open.dropped).toEqual([]);
  });

  it("one depth limit: a block at MAX_DEPTH is kept, one deeper is dropped and named", () => {
    const nest = (levels: number) => {
      let block: Record<string, unknown> = {
        type: "Text",
        props: { id: "leaf", text: "x" },
      };
      for (let i = levels - 1; i >= 0; i--)
        block = { type: "Stack", props: { id: `s${i}`, children: [block] } };
      return block;
    };
    const kept = parseBoard(board(frame("f", [nest(MAX_DEPTH)])), schema);
    expect(kept.ok && kept.dropped).toEqual([]);
    expect(kept.ok && boardComponents(kept.board)).toEqual(["Stack", "Text"]);
    const deep = parseBoard(board(frame("f", [nest(MAX_DEPTH + 1)])), schema);
    expect(deep.ok && deep.dropped).toEqual([
      { kind: "too-deep", type: "Text" },
    ]);
    // Without a schema too: the depth is the shape's, not the catalog's.
    const bare = parseBoard(board(frame("f", [nest(MAX_DEPTH + 1)])));
    expect(bare.ok && bare.dropped).toEqual([
      { kind: "too-deep", type: "Text" },
    ]);
  });

  it("a v3 page with non-empty zones: the zones are dropped and named, never silently", () => {
    const r = parseBoard(
      board(
        frame("f", [], {
          zones: {
            "Stack:s1/children": [{ type: "Text", props: { id: "z" } }],
            empty: [],
          },
        })
      ),
      schema
    );
    expect(r.ok && r.dropped).toEqual([
      { kind: "legacy-zones", keys: ["Stack:s1/children"] },
    ]);
  });

  it("frames without a position, or with an id already used, are dropped and named", () => {
    const r = parseBoard(
      board(frame("a", []), { id: "b", name: "B" }, frame("a", []))
    );
    expect(r.ok && r.board.frames.map((f) => f.id)).toEqual(["a"]);
    expect(r.ok && r.dropped).toEqual([
      { kind: "bad-frame" },
      { kind: "duplicate-frame", id: "a" },
    ]);
  });
});

describe("block ids are unique in the BOARD (a critique's nodeId addresses the whole design)", () => {
  it("the same id in two frames: the first frame keeps it, the second gets the next free one", () => {
    const r = parseBoard(
      board(
        frame("f1", [{ type: "Heading", props: { id: "h", text: "a" } }]),
        frame("f2", [
          { type: "Heading", props: { id: "h", text: "b" } },
          { type: "Text", props: { text: "c" } },
        ])
      ),
      schema
    );
    if (!r.ok) throw new Error(r.error);
    expect(
      r.board.frames.map((f) => f.page.content.map((b) => b.props.id))
    ).toEqual([["h"], ["Heading-1", "Text-1"]]);
  });

  it("nextBlockId: `<type>-<n>`, the first number not taken, and takes it", () => {
    const taken = new Set(["Text-1", "Text-3"]);
    expect(nextBlockId(taken, "Text")).toBe("Text-2");
    expect(nextBlockId(taken, "Text")).toBe("Text-4");
    expect(taken.has("Text-2") && taken.has("Text-4")).toBe(true);
  });

  it("reIdBlocks: a duplicated frame's blocks all get new ids (slots too); free ids are kept; the input is untouched", () => {
    const blocks: PageBlock[] = [
      {
        type: "Stack",
        props: {
          id: "s",
          children: [{ type: "Text", props: { id: "t", text: "x" } }],
        },
      },
      { type: "Heading", props: { id: "free", text: "y" } },
    ];
    const snapshot = JSON.parse(JSON.stringify(blocks));
    const taken = new Set(["s", "t", "Stack-1"]);
    const copy = reIdBlocks(blocks, taken);
    expect([...walkBlocks(copy)].map((b) => b.props.id)).toEqual([
      "Stack-2",
      "Text-1",
      "free",
    ]);
    expect((copy[0]!.props.children as PageBlock[])[0]!.props.text).toBe("x");
    expect(blocks).toEqual(snapshot);
    expect(
      taken.has("Stack-2") && taken.has("Text-1") && taken.has("free")
    ).toBe(true);
  });
});

describe("one walker: where a block's children are", () => {
  const card = {
    type: "Card",
    props: {
      id: "c",
      body: [{ type: "Text", props: { id: "t" } }],
      options: [{ label: "not a block" }],
      stray: [{ type: "Heading", props: { id: "h" } }],
    },
  };
  const cardSchema: CanvasSchema = {
    Card: {
      body: { kind: "slot" },
      options: {
        kind: "list",
        item: { label: { kind: "text" } },
        required: [],
      },
    },
  };

  it("with a schema: the declared slots only", () => {
    expect(
      childLists(card, cardSchema).map((c) => [
        c.prop,
        c.blocks.map((b) => b.props.id),
      ])
    ).toEqual([["body", ["t"]]]);
  });

  it("without one: every prop that holds blocks (never a list of plain items)", () => {
    expect(childLists(card).map((c) => c.prop)).toEqual(["body", "stray"]);
  });

  it("walkBlocks: parents before children, in reading order", () => {
    expect([...walkBlocks([card], cardSchema)].map((b) => b.props.id)).toEqual([
      "c",
      "t",
    ]);
    expect([...walkBlocks([card])].map((b) => b.props.id)).toEqual([
      "c",
      "t",
      "h",
    ]);
  });
});

describe("parseBoard (schema-1 Puck page)", () => {
  const page = {
    root: { props: { title: "t" } },
    content: [
      { type: "Heading", props: { id: "h", text: "Hi" } },
      { type: "Text", props: {} },
    ],
    zones: {
      "Stack:s1/children": [{ type: "Text", props: { id: "z" } }],
      "Stack:s2/children": [],
    },
  };

  it("opens as one frame 'Page', ids filled, migrated", () => {
    const r = parseBoard(page, schema);
    if (!r.ok) throw new Error(r.error);
    expect(r.migrated).toBe(true);
    expect(r.board.frames).toHaveLength(1);
    expect(r.board.frames[0]).toMatchObject({
      name: "Page",
      x: 0,
      y: 0,
      w: 1440,
      h: 900,
    });
    expect(r.board.frames[0]!.page.root).toEqual({ props: { title: "t" } });
    expect(r.board.frames[0]!.page.content.map((b) => b.props.id)).toEqual([
      "h",
      "Text-1",
    ]);
  });

  it("drops non-empty zones and names them, never silently", () => {
    const r = parseBoard(page, schema);
    expect(r.ok && r.dropped).toEqual([
      { kind: "legacy-zones", keys: ["Stack:s1/children"] },
    ]);
    const none = parseBoard({ ...page, zones: {} }, schema);
    expect(none.ok && none.dropped).toEqual([]);
  });
});

describe("parseBoard (v2 migration)", () => {
  const v2 = {
    format: LEGACY_BOARD_FORMAT,
    frames: [
      { id: "f1", name: "Home", x: 0, y: 0, w: 1440, h: 900 },
      { id: "f2", name: "Phone", x: 1600, y: 0, w: 390, h: 844 },
    ],
    items: [
      {
        id: "late",
        component: "Text",
        props: { text: "b" },
        frame: "f1",
        x: 10,
        y: 200,
        w: 100,
        h: 20,
      },
      {
        id: "right",
        component: "Heading",
        props: { text: "r" },
        frame: "f1",
        x: 300,
        y: 50,
        w: 100,
        h: 20,
      },
      {
        id: "left",
        component: "Heading",
        props: { text: "l" },
        frame: "f1",
        x: 20,
        y: 50,
        w: 100,
        h: 20,
      },
      {
        id: "p",
        component: "SpatialButton",
        props: {},
        frame: "f2",
        x: 0,
        y: 0,
      },
      { id: "free", component: "Text", props: { text: "free" }, x: 5, y: 5 },
      {
        id: "orphan",
        component: "Heading",
        props: {},
        frame: "gone",
        x: 9,
        y: 9,
      },
      { id: "z", component: "Nope", props: {}, x: 0, y: 0 },
    ],
  };

  it("puts each frame's items in its page in reading order (y then x), ids kept, geometry gone", () => {
    const r = parseBoard(v2, schema);
    if (!r.ok) throw new Error(r.error);
    expect(r.migrated).toBe(true);
    expect(r.board.format).toBe(BOARD_FORMAT);
    const home = r.board.frames.find((f) => f.id === "f1")!;
    expect(home.page.content.map((b) => b.props.id)).toEqual([
      "left",
      "right",
      "late",
    ]);
    expect(home.page.content[0]).toEqual({
      type: "Heading",
      props: { text: "l", id: "left" },
    });
    expect(
      r.board.frames.find((f) => f.id === "f2")!.page.content.map((b) => b.type)
    ).toEqual(["SpatialButton"]);
    expect(r.dropped).toEqual([{ kind: "unknown-type", type: "Nope" }]);
  });

  it("puts loose items in one 'Loose components' frame right of the rightmost frame; nothing is lost", () => {
    const r = parseBoard(v2, schema);
    if (!r.ok) throw new Error(r.error);
    const loose = r.board.frames.find((f) => f.name === "Loose components")!;
    // rightmost frame edge is 1600 + 390 = 1990; gap 160.
    expect(loose).toMatchObject({ x: 2150, y: 0, w: 1440, h: 900 });
    expect(loose.page.content.map((b) => b.props.id)).toEqual([
      "free",
      "orphan",
    ]);
    const all = r.board.frames.flatMap((f) =>
      f.page.content.map((b) => b.props.id)
    );
    expect(all.sort()).toEqual([
      "free",
      "late",
      "left",
      "orphan",
      "p",
      "right",
    ]);
  });

  it("adds no loose frame when every item sits on a frame", () => {
    const r = parseBoard({ ...v2, items: v2.items.slice(0, 4) }, schema);
    expect(r.ok && r.board.frames.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("a v2 board's migrated slot blocks get ids", () => {
    const r = parseBoard(
      {
        format: LEGACY_BOARD_FORMAT,
        frames: [],
        items: [
          {
            id: "s",
            component: "Stack",
            props: { children: [{ type: "Text", props: {} }] },
            x: 0,
            y: 0,
          },
        ],
      },
      schema
    );
    if (!r.ok) throw new Error(r.error);
    const stack = r.board.frames[0]!.page.content[0]!;
    expect((stack.props.children as PageBlock[])[0]!.props.id).toBe("Text-1");
  });
});

describe("viewport frames: a frame may show another frame's page (`pageOf`)", () => {
  const text = (id: string) => ({ type: "Text", props: { id, text: id } });

  it("a frame showing a page-owning frame keeps its pageOf, and draws that frame's page", () => {
    const r = parseBoard(
      board(frame("d", [text("t1")]), {
        ...frame("t", []),
        w: 834,
        pageOf: "d",
      }),
      schema
    );
    if (!r.ok) throw new Error("fixture");
    expect(r.dropped).toEqual([]);
    const [desktop, tablet] = r.board.frames;
    expect(tablet!.pageOf).toBe("d");
    expect(pageOwner(r.board, tablet!)).toBe(desktop);
    expect(pageOwner(r.board, desktop!)).toBe(desktop);
  });

  it("a pageOf naming itself, a missing frame or another viewer, or on a frame with blocks, is dropped and named; the blocks stay", () => {
    const r = parseBoard(
      board(
        frame("d", []),
        { ...frame("self", []), pageOf: "self" },
        { ...frame("gone", []), pageOf: "nowhere" },
        { ...frame("t", []), pageOf: "d" },
        { ...frame("chain", []), pageOf: "t" },
        { ...frame("own", [text("x1")]), pageOf: "d" },
        { ...frame("num", []), pageOf: 3 }
      ),
      schema
    );
    if (!r.ok) throw new Error("fixture");
    expect(
      r.board.frames.filter((f) => "pageOf" in f).map((f) => f.id)
    ).toEqual(["t"]);
    expect(r.dropped).toEqual(
      ["self", "gone", "chain", "own", "num"].map((id) => ({
        kind: "bad-page-of",
        frame: id,
      }))
    );
    expect(
      r.board.frames
        .find((f) => f.id === "own")!
        .page.content.map((b) => b.props.id)
    ).toEqual(["x1"]);
  });
});

describe("span, start and hide per width class: every block has them, checked by the one door", () => {
  const block = (props: Record<string, unknown>) =>
    parseBoard(
      board(
        frame("f", [{ type: "Text", props: { id: "t", text: "a", ...props } }])
      ),
      schema
    );

  it("a whole number of the class's columns (4 / 8 / 12) and a boolean hide are kept as written", () => {
    const r = block({
      span: { compact: 4, medium: 3, expanded: 12 },
      hide: { compact: true, expanded: false },
    });
    if (!r.ok) throw new Error("fixture");
    expect(r.dropped).toEqual([]);
    expect(r.board.frames[0]!.page.content[0]!.props).toMatchObject({
      span: { compact: 4, medium: 3, expanded: 12 },
      hide: { compact: true, expanded: false },
    });
  });

  it("a span wider than its class, not whole, or for no class, and a hide that is not a boolean, are dropped and named; the rest stays", () => {
    const r = block({
      span: { compact: 5, medium: 2.5, expanded: 6, wide: 2 },
      hide: { medium: "yes", compact: true },
    });
    if (!r.ok) throw new Error("fixture");
    expect(r.board.frames[0]!.page.content[0]!.props).toMatchObject({
      span: { expanded: 6 },
      hide: { compact: true },
    });
    expect(r.dropped).toEqual([
      { kind: "bad-prop", type: "Text", prop: "span" },
      { kind: "bad-prop", type: "Text", prop: "hide" },
    ]);
  });

  it("a start column fits its class with the span: kept as written; past the columns it is dropped and named, the span stays", () => {
    const fits = block({
      span: { expanded: 4, compact: 2 },
      start: { expanded: 9, compact: 3, medium: 8 },
    });
    if (!fits.ok) throw new Error("fixture");
    expect(fits.dropped).toEqual([]);
    expect(fits.board.frames[0]!.page.content[0]!.props).toMatchObject({
      span: { expanded: 4, compact: 2 },
      // No span at medium: from column 8 to the row's end.
      start: { expanded: 9, compact: 3, medium: 8 },
    });
    const past = block({
      span: { expanded: 4 },
      start: { expanded: 10, compact: 5, medium: 2 },
    });
    if (!past.ok) throw new Error("fixture");
    expect(past.board.frames[0]!.page.content[0]!.props).toMatchObject({
      span: { expanded: 4 },
      start: { medium: 2 },
    });
    expect(past.dropped).toEqual([
      { kind: "bad-prop", type: "Text", prop: "start" },
    ]);
  });

  it("a start that keeps nothing goes entirely; a class set to undefined (a cleared field) is simply not set", () => {
    const gone = block({ span: { expanded: 12 }, start: { expanded: 2 } });
    if (!gone.ok) throw new Error("fixture");
    expect(gone.board.frames[0]!.page.content[0]!.props).not.toHaveProperty(
      "start"
    );
    expect(gone.dropped).toEqual([
      { kind: "bad-prop", type: "Text", prop: "start" },
    ]);
    const cleared = block({ start: { expanded: undefined, compact: 2 } });
    if (!cleared.ok) throw new Error("fixture");
    expect(cleared.dropped).toEqual([]);
    expect(cleared.board.frames[0]!.page.content[0]!.props.start).toEqual({
      compact: 2,
    });
  });

  it("a span that is not an object, or keeps nothing, goes entirely", () => {
    const r = block({ span: 6, hide: { compact: 1 } });
    if (!r.ok) throw new Error("fixture");
    expect(r.board.frames[0]!.page.content[0]!.props).not.toHaveProperty(
      "span"
    );
    expect(r.board.frames[0]!.page.content[0]!.props).not.toHaveProperty(
      "hide"
    );
    expect(r.dropped).toHaveLength(2);
  });
});
