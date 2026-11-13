import { describe, expect, it } from "vitest";
import {
  BOARD_PLACEMENT_META_KEYS,
  BOARD_SHAPE_TYPES,
  PLACED_SHAPE_ID_PREFIX,
  PlaceOnBoardRequestSchema,
  boardPlacementContext,
  boardRoomId,
  boardStoreMapName,
  buildPlacementRecords,
  indexAbove,
  isValidIndexKey,
  placedShapeId,
  shapeRemovalIds,
  type BoardRecord,
} from "./index.js";

const PLACED_BY = { userId: "u-1", agentUserId: "agent-1" };
const AT = "2026-11-13T12:00:00.000Z";

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
    props: { w: 100, h: 50 },
    meta: {},
    ...over,
  };
}

const board = (...recs: BoardRecord[]) =>
  Object.fromEntries(
    [
      {
        id: "page:p1",
        typeName: "page",
        name: "Page 1",
        index: "a1",
        meta: {},
      },
      ...recs,
    ].map((r) => [r.id, r])
  );

/** The envelope tldraw 2.4.6 `createShapeValidator` checks, key for key. */
function expectTldrawShapeEnvelope(r: BoardRecord) {
  expect(Object.keys(r).sort()).toEqual(
    [
      "id",
      "typeName",
      "x",
      "y",
      "rotation",
      "index",
      "parentId",
      "type",
      "isLocked",
      "opacity",
      "props",
      "meta",
    ].sort()
  );
  expect(r.id.startsWith("shape:")).toBe(true);
  expect(isValidIndexKey(r.index)).toBe(true);
  expect(String(r.parentId)).toMatch(/^(page|shape):/);
  // JSON all the way down: `undefined` fails tldraw's jsonValue validator.
  expect(JSON.parse(JSON.stringify(r))).toEqual(r);
}

describe("frozen persisted names", () => {
  it("keeps the stored names boards already hold", () => {
    expect(BOARD_SHAPE_TYPES).toEqual({
      entityCard: "entityCard",
      view: "view",
      cell: "cell",
      sticky: "sticky",
      artboard: "artboard",
      synapFrame: "synap-frame",
    });
    expect(BOARD_PLACEMENT_META_KEYS).toEqual({
      pending: "pending",
      placedBy: "placedBy",
      placedAt: "placedAt",
      fitToMedia: "fitToMedia",
    });
    expect(boardRoomId("d1")).toBe("whiteboard-d1");
    expect(boardStoreMapName("d1")).toBe("tl_map_d1");
    expect(PLACED_SHAPE_ID_PREFIX).toBe("shape:synap-placed-");
  });
});

describe("indexAbove", () => {
  it("is tldraw's getIndexAbove (values checked against @tldraw/utils 2.4.6)", () => {
    expect(indexAbove(undefined)).toBe("a0");
    expect(indexAbove("a0")).toBe("a1");
    expect(indexAbove("a1V")).toBe("a2");
    expect(indexAbove("a9")).toBe("aA");
    expect(indexAbove("az")).toBe("b00");
    expect(indexAbove("Zz")).toBe("a0");
    expect(indexAbove("zzzzzzzzzzzzzzzzzzzzzzzzzzz")).toBe(
      "zzzzzzzzzzzzzzzzzzzzzzzzzzzV"
    );
  });
  it("refuses a key tldraw refuses", () => {
    expect(isValidIndexKey("a10")).toBe(false);
    expect(isValidIndexKey("")).toBe(false);
    expect(() => indexAbove("a10")).toThrow();
  });
});

describe("buildPlacementRecords", () => {
  const ctxOf = (recs: Record<string, unknown>) => boardPlacementContext(recs);

  it("places each kind as the shape the browser placer makes, marked pending", () => {
    const recs = board(shape("shape:a", { index: "a5" }));
    const built = buildPlacementRecords({
      resources: [
        { kind: "entity", entityId: "e-1", title: "Acme" },
        { kind: "view", viewId: "v-1" },
        {
          kind: "cellInstance",
          cellInstanceId: "c-1",
          cellKey: "html-embed",
          defaultSize: { w: 6, h: 4 },
        },
      ],
      placementKey: "k1",
      context: ctxOf(recs),
      placedBy: PLACED_BY,
      placedAt: AT,
      pending: true,
    });
    expect(built.records.map((r) => r.type)).toEqual([
      "entityCard",
      "view",
      "cell",
    ]);
    for (const r of built.records) {
      expectTldrawShapeEnvelope(r);
      expect(r.parentId).toBe("page:p1");
      expect(r.meta).toMatchObject({
        pending: true,
        placedBy: PLACED_BY,
        placedAt: AT,
      });
    }
    // Stacked above what the page already holds, in order.
    expect(built.records.map((r) => r.index)).toEqual(["a6", "a7", "a8"]);
    const [card, view, cell] = built.records;
    expect(card.props).toMatchObject({
      w: 240,
      h: 160,
      entityId: "e-1",
      entityType: "entity",
      profileId: null,
      title: "Acme",
      properties: {},
      status: "active",
      progress: 0,
    });
    expect(card.meta).toMatchObject({ fitToMedia: true });
    expect(view.props).toEqual({
      w: 600,
      h: 400,
      referenceMode: "live",
      viewId: "v-1",
      viewType: "table",
      title: "Embedded View",
    });
    expect(cell.props).toEqual({
      w: 360,
      h: 240,
      cellInstanceId: "c-1",
      cellKey: "html-embed",
      cellProps: "{}",
      title: "",
    });
    expect(built.shapeIds).toEqual(built.records.map((r) => r.id));
  });

  it("fixes ids by the placement key: the same call yields the same ids", () => {
    const args = {
      resources: [{ kind: "entity" as const, entityId: "e-1" }],
      context: ctxOf(board()),
      placedBy: PLACED_BY,
      placedAt: AT,
      pending: true,
    };
    const a = buildPlacementRecords({ ...args, placementKey: "same" });
    const b = buildPlacementRecords({ ...args, placementKey: "same" });
    const c = buildPlacementRecords({ ...args, placementKey: "other" });
    expect(a.shapeIds).toEqual(b.shapeIds);
    expect(a.shapeIds[0]).toBe(placedShapeId("same", 0));
    expect(a.shapeIds[0].startsWith(PLACED_SHAPE_ID_PREFIX)).toBe(true);
    expect(c.shapeIds[0]).not.toBe(a.shapeIds[0]);
  });

  it("does not mark a shape pending when asked not to (an approved proposal)", () => {
    const built = buildPlacementRecords({
      resources: [{ kind: "entity", entityId: "e-1" }],
      placementKey: "k",
      context: ctxOf(board()),
      placedBy: { ...PLACED_BY, proposalId: "p-1" },
      placedAt: AT,
      pending: false,
    });
    expect(built.records[0].meta).not.toHaveProperty("pending");
    expect(built.records[0].meta).toMatchObject({
      placedBy: { proposalId: "p-1" },
    });
  });

  it("lays an artboard deck out as one artboard per slide, each holding its html cell", () => {
    const recs = board(
      shape("shape:old-board", {
        type: "artboard",
        props: { w: 640, h: 360, pageIndex: 3 },
      })
    );
    const built = buildPlacementRecords({
      resources: [
        {
          kind: "artboard-deck-materialized",
          preset: "linkedin-carousel",
          title: "Launch",
          slides: [
            { cellInstanceId: "c-1", title: "One" },
            { cellInstanceId: "c-2" },
          ],
        },
      ],
      options: { x: 100, y: 200 },
      placementKey: "deck",
      context: ctxOf(recs),
      placedBy: PLACED_BY,
      placedAt: AT,
      pending: true,
    });
    const boards = built.records.filter((r) => r.type === "artboard");
    const cells = built.records.filter((r) => r.type === "cell");
    expect(boards).toHaveLength(2);
    expect(cells).toHaveLength(2);
    expect(built.shapeIds).toEqual(boards.map((b) => b.id));
    for (const r of built.records) expectTldrawShapeEnvelope(r);
    // Page index continues after the board's highest artboard page.
    expect(
      boards.map((b) => (b.props as { pageIndex: number }).pageIndex)
    ).toEqual([4, 5]);
    expect(boards[0].props).toMatchObject({
      presetId: "linkedin-carousel",
      outputWidth: 1080,
      outputHeight: 1350,
      w: 512,
      h: 640,
      title: "One",
      background: "paper",
    });
    expect(boards[1].props).toMatchObject({ title: "Launch" });
    // Left to right from the anchor, DECK_GAP apart.
    expect(boards[0].x).toBe(100);
    expect(boards[1].x).toBe(100 + 512 + 48);
    expect(boards[0].y).toBe(200);
    // Each cell is its artboard's child at (0,0), filling it.
    cells.forEach((cell, i) => {
      expect(cell.parentId).toBe(boards[i].id);
      expect(cell.x).toBe(0);
      expect(cell.y).toBe(0);
      expect(cell.props).toMatchObject({
        w: 512,
        h: 640,
        cellKey: "html-embed",
        cellInstanceId: `c-${i + 1}`,
      });
    });
  });

  it("places INTO a frame with coordinates relative to the frame", () => {
    const recs = board(
      shape("shape:frame", {
        type: "frame",
        x: 1000,
        y: 500,
        index: "a2",
        props: { w: 800, h: 600 },
      }),
      shape("shape:inside", { parentId: "shape:frame", index: "a3" })
    );
    const built = buildPlacementRecords({
      resources: [{ kind: "entity", entityId: "e-1" }],
      options: { x: 1200, y: 700, frameId: "shape:frame" },
      placementKey: "f",
      context: ctxOf(recs),
      placedBy: PLACED_BY,
      placedAt: AT,
      pending: true,
    });
    const [card] = built.records;
    expect(card.parentId).toBe("shape:frame");
    // Page (1200 - 120, 700 - 80) minus the frame's page position.
    expect(card.x).toBe(1080 - 1000);
    expect(card.y).toBe(620 - 500);
    expect(card.index).toBe("a4");
  });

  it("refuses a frame the board does not hold", () => {
    expect(() =>
      buildPlacementRecords({
        resources: [{ kind: "entity", entityId: "e-1" }],
        options: { frameId: "shape:nope" },
        placementKey: "f",
        context: ctxOf(board()),
        placedBy: PLACED_BY,
        placedAt: AT,
        pending: true,
      })
    ).toThrow(/frameId/);
  });

  it("anchors to the right of what the board holds when no point is given", () => {
    const recs = board(
      shape("shape:a", { x: 0, y: 40, props: { w: 300, h: 100 } })
    );
    const built = buildPlacementRecords({
      resources: [{ kind: "entity", entityId: "e-1" }],
      placementKey: "k",
      context: ctxOf(recs),
      placedBy: PLACED_BY,
      placedAt: AT,
      pending: true,
    });
    expect(built.records[0].x).toBe(300 + 120);
    expect(built.records[0].y).toBe(40);
  });

  it("writes a page record on a board that has none", () => {
    const built = buildPlacementRecords({
      resources: [{ kind: "entity", entityId: "e-1" }],
      placementKey: "k",
      context: boardPlacementContext({}),
      placedBy: PLACED_BY,
      placedAt: AT,
      pending: true,
    });
    expect(built.records[0]).toEqual({
      id: "page:page",
      typeName: "page",
      name: "Page 1",
      index: "a1",
      meta: {},
    });
    expect(built.records[1].parentId).toBe("page:page");
    expect(built.shapeIds).toEqual([built.records[1].id]);
  });
});

describe("updates and removals", () => {
  const recs = board(
    shape("shape:frame", { type: "frame", props: { w: 500, h: 500 } }),
    shape("shape:child", { parentId: "shape:frame" }),
    shape("shape:grandchild", { parentId: "shape:child" }),
    shape("shape:other"),
    {
      id: "binding:b1",
      typeName: "binding",
      type: "arrow",
      fromId: "shape:arrow",
      toId: "shape:child",
    } as BoardRecord
  );

  it("removes a shape with everything it holds and the bindings pointing at them", () => {
    const { ids, missing } = shapeRemovalIds(recs, [
      "shape:frame",
      "shape:nope",
    ]);
    expect(missing).toEqual(["shape:nope"]);
    expect(ids.sort()).toEqual(
      ["binding:b1", "shape:child", "shape:frame", "shape:grandchild"].sort()
    );
  });
});

describe("PlaceOnBoardRequestSchema", () => {
  it("accepts every resource kind the browser placer accepts", () => {
    const parsed = PlaceOnBoardRequestSchema.safeParse({
      resources: [
        { kind: "entity", entityId: "00000000-0000-4000-8000-000000000001" },
        { kind: "view", viewId: "00000000-0000-4000-8000-000000000002" },
        {
          kind: "cellInstance",
          cellInstanceId: "00000000-0000-4000-8000-000000000003",
        },
        { kind: "cellDefinition", cellKey: "kpi" },
        { kind: "html", name: "Hi", html: "<p>hi</p>" },
        {
          kind: "artboard-deck",
          preset: "slide-16-9",
          slides: [{ html: "<p/>" }],
        },
        {
          kind: "automation",
          automationId: "00000000-0000-4000-8000-000000000004",
          mode: "flow",
        },
        { kind: "url", url: "https://example.com" },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses an empty call", () => {
    expect(PlaceOnBoardRequestSchema.safeParse({}).success).toBe(false);
    expect(PlaceOnBoardRequestSchema.safeParse({ resources: [] }).success).toBe(
      false
    );
  });

  it("accepts a change-only call", () => {
    expect(
      PlaceOnBoardRequestSchema.safeParse({ remove: ["shape:a"] }).success
    ).toBe(true);
    expect(
      PlaceOnBoardRequestSchema.safeParse({ remove: ["not-a-shape"] }).success
    ).toBe(false);
  });
});
