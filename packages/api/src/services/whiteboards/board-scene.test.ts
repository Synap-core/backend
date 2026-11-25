/**
 * buildBoardScene — fixtures in the record shapes a tldraw 2.4.6 board really
 * stores (`@tldraw/tlschema` 2.4.6: shape records, `binding` records for arrow
 * ends, page / document / camera bookkeeping) and the props Synap's own shape
 * utils write (synap-app `packages/web/src/whiteboard/shapes/*ShapeUtil.tsx`,
 * `packages/web/src/artboards/model.ts`, `placement/placeResourcesOnWhiteboard.ts`).
 *
 * Each row is chosen to rule a wrong rule OUT: a child's coordinates are
 * relative to its parent (a reader that ignores parents gives the wrong x/y),
 * an arrow end lives on a separate binding record (a reader of `props.start`
 * alone sees a free point at 0,0), a legacy arrow keeps its binding on the
 * shape (a reader of binding records alone loses it), `cellInstanceId: ""`
 * means "no instance" (a reader of truthy strings must not report it), and an
 * unknown record is counted, not dropped silently or thrown on.
 */

import { describe, expect, it } from "vitest";
import {
  BOARD_TEXT_MAX_CHARS,
  buildBoardScene,
  windowBoardScene,
} from "./board-scene.js";

const PAGE = "page:page";
const shape = (
  id: string,
  type: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  typeName: "shape",
  id,
  type,
  x: 0,
  y: 0,
  rotation: 0,
  index: "a1",
  parentId: PAGE,
  isLocked: false,
  opacity: 1,
  meta: {},
  props: {},
  ...extra,
});
const store = (...records: Array<Record<string, unknown>>) =>
  Object.fromEntries(records.map((r) => [r.id as string, r]));

const BOOKKEEPING = [
  { typeName: "document", id: "document:document", gridSize: 10, name: "" },
  { typeName: "page", id: PAGE, name: "Page 1", index: "a1", meta: {} },
  { typeName: "camera", id: "camera:page:page", x: 0, y: 0, z: 1 },
];

describe("buildBoardScene: Synap shapes", () => {
  const scene = buildBoardScene(
    store(
      ...BOOKKEEPING,
      shape("shape:card", "entityCard", {
        x: 100,
        y: 50,
        props: {
          w: 280,
          h: 160,
          entityId: "11111111-1111-4111-8111-111111111111",
          entityType: "deal",
          profileId: null,
          title: "Acme renewal",
          properties: {},
          status: "active",
          progress: 0,
        },
      }),
      shape("shape:view", "view", {
        x: 500,
        y: 50,
        props: {
          w: 600,
          h: 400,
          referenceMode: "live",
          viewId: "22222222-2222-4222-8222-222222222222",
          viewType: "kanban",
          title: "Pipeline",
        },
      }),
      shape("shape:cell", "cell", {
        x: 0,
        y: 600,
        props: {
          w: 300,
          h: 200,
          cellKey: "url-embed",
          cellProps: JSON.stringify({ url: "https://example.com/a" }),
          cellInstanceId: "33333333-3333-4333-8333-333333333333",
          title: "Docs",
        },
      }),
      shape("shape:inline-cell", "cell", {
        x: 400,
        y: 600,
        props: {
          w: 300,
          h: 200,
          cellKey: "stat-card",
          cellProps: "{not json",
          cellInstanceId: "",
          title: "",
        },
      }),
      shape("shape:sticky", "sticky", {
        x: 0,
        y: 0,
        props: { w: 240, h: 200, content: "Call Bob", color: "yellow" },
      }),
      shape("shape:pending", "sticky", {
        x: 0,
        y: 300,
        props: { w: 240, h: 200, content: "From the agent", color: "blue" },
        meta: {
          pending: true,
          placedBy: {
            agentUserId: "44444444-4444-4444-8444-444444444444",
            proposalId: "55555555-5555-4555-8555-555555555555",
          },
        },
      })
    )
  );
  const byId = Object.fromEntries(scene.shapes.map((s) => [s.id, s]));

  it("reads an entity card's reference, title and bounds", () => {
    expect(byId["shape:card"]).toEqual({
      id: "shape:card",
      type: "entityCard",
      parentId: null,
      pageId: PAGE,
      frameId: null,
      x: 100,
      y: 50,
      w: 280,
      h: 160,
      rotation: 0,
      title: "Acme renewal",
      refs: {
        entityId: "11111111-1111-4111-8111-111111111111",
        entityType: "deal",
      },
    });
  });

  it("reads a view shape's viewId and type", () => {
    expect(byId["shape:view"]!.refs).toEqual({
      viewId: "22222222-2222-4222-8222-222222222222",
      viewType: "kanban",
    });
    expect(byId["shape:view"]!.title).toBe("Pipeline");
  });

  it("reads a cell's instance, key and the url inside its cellProps JSON", () => {
    expect(byId["shape:cell"]!.refs).toEqual({
      cellInstanceId: "33333333-3333-4333-8333-333333333333",
      cellKey: "url-embed",
      url: "https://example.com/a",
    });
  });

  it("an empty cellInstanceId is 'no instance', and bad cellProps JSON is not a crash", () => {
    expect(byId["shape:inline-cell"]!.refs).toEqual({ cellKey: "stat-card" });
    expect(byId["shape:inline-cell"]!.title).toBeUndefined();
  });

  it("reads a sticky's content as its text", () => {
    expect(byId["shape:sticky"]!.text).toBe("Call Bob");
  });

  it("carries the pending mark and who placed the shape", () => {
    expect(byId["shape:pending"]!.pending).toBe(true);
    expect(byId["shape:pending"]!.placedBy).toEqual({
      agentUserId: "44444444-4444-4444-8444-444444444444",
      proposalId: "55555555-5555-4555-8555-555555555555",
    });
    expect(byId["shape:sticky"]!.pending).toBeUndefined();
  });

  it("orders shapes top to bottom, then left to right", () => {
    expect(scene.shapes.map((s) => s.id)).toEqual([
      "shape:sticky",
      "shape:card",
      "shape:view",
      "shape:pending",
      "shape:cell",
      "shape:inline-cell",
    ]);
  });

  it("counts records, shapes by type, the page, and skips tldraw bookkeeping by typeName", () => {
    expect(scene.pages).toEqual([{ id: PAGE, name: "Page 1" }]);
    expect(scene.counts).toEqual({
      records: 9,
      shapes: 6,
      arrows: 0,
      byType: { entityCard: 1, view: 1, cell: 2, sticky: 2 },
      skipped: { document: 1, camera: 1 },
    });
  });

  it("bounds every sized shape in page space", () => {
    expect(scene.bounds).toEqual({ x: 0, y: 0, w: 1100, h: 800 });
  });
});

describe("buildBoardScene: an artboard with children", () => {
  const scene = buildBoardScene(
    store(
      ...BOOKKEEPING,
      shape("shape:art", "artboard", {
        x: 1000,
        y: 2000,
        props: {
          w: 640,
          h: 360,
          title: "Slide 1",
          presetId: "slide-16-9",
          outputWidth: 1920,
          outputHeight: 1080,
          pageIndex: 3,
          background: "paper",
          showSafeArea: false,
          safeInset: 0,
          showBleed: false,
          bleed: 0,
        },
      }),
      // Reparented into the artboard: x/y are RELATIVE to it.
      shape("shape:slide", "cell", {
        parentId: "shape:art",
        x: 0,
        y: 0,
        props: {
          w: 640,
          h: 360,
          cellInstanceId: "66666666-6666-4666-8666-666666666666",
          cellKey: "html-embed",
          cellProps: "{}",
          title: "Slide 1",
        },
      }),
      // A native section holding a text, nested inside the artboard.
      shape("shape:section", "frame", {
        parentId: "shape:art",
        x: 20,
        y: 30,
        props: { w: 200, h: 100, name: "Notes" },
      }),
      shape("shape:caption", "text", {
        parentId: "shape:section",
        x: 5,
        y: 6,
        props: { text: "Q4 numbers", w: 80, autoSize: true },
      })
    )
  );
  const byId = Object.fromEntries(scene.shapes.map((s) => [s.id, s]));

  it("reads the artboard's preset and page", () => {
    expect(byId["shape:art"]!.artboard).toEqual({
      presetId: "slide-16-9",
      pageIndex: 3,
      outputWidth: 1920,
      outputHeight: 1080,
    });
    expect(byId["shape:art"]!.title).toBe("Slide 1");
  });

  it("gives a child page coordinates, its parent and its frame", () => {
    expect(byId["shape:slide"]).toMatchObject({
      parentId: "shape:art",
      frameId: "shape:art",
      pageId: PAGE,
      x: 1000,
      y: 2000,
    });
  });

  it("a nested shape takes its nearest frame and every parent's offset", () => {
    expect(byId["shape:section"]!.title).toBe("Notes");
    expect(byId["shape:caption"]).toMatchObject({
      parentId: "shape:section",
      frameId: "shape:section",
      pageId: PAGE,
      x: 1025,
      y: 2036,
      text: "Q4 numbers",
    });
  });
});

describe("buildBoardScene: arrows", () => {
  const A = "shape:a";
  const B = "shape:b";
  const cards = [
    shape(A, "entityCard", {
      x: 0,
      y: 0,
      props: { w: 100, h: 100, entityId: "e-a", title: "A" },
    }),
    shape(B, "entityCard", {
      x: 400,
      y: 0,
      props: { w: 100, h: 100, entityId: "e-b", title: "B" },
    }),
  ];

  it("2.4.6 form: each end is a binding record, read with the relation it draws", () => {
    const scene = buildBoardScene(
      store(
        ...BOOKKEEPING,
        ...cards,
        shape("shape:arrow", "arrow", {
          x: 50,
          y: 50,
          meta: { graphSourced: true, relationId: "rel-1" },
          props: {
            start: { x: 0, y: 0 },
            end: { x: 0, y: 0 },
            bend: 0,
            text: "owns",
            labelPosition: 0.5,
            scale: 1,
          },
        }),
        {
          typeName: "binding",
          id: "binding:s",
          type: "arrow",
          fromId: "shape:arrow",
          toId: A,
          meta: {},
          props: {
            terminal: "start",
            normalizedAnchor: { x: 0.5, y: 0.5 },
            isExact: false,
            isPrecise: false,
          },
        },
        {
          typeName: "binding",
          id: "binding:e",
          type: "arrow",
          fromId: "shape:arrow",
          toId: B,
          meta: {},
          props: {
            terminal: "end",
            normalizedAnchor: { x: 0, y: 0.5 },
            isExact: false,
            isPrecise: true,
          },
        }
      )
    );
    expect(scene.arrows).toEqual([
      {
        id: "shape:arrow",
        parentId: null,
        pageId: PAGE,
        frameId: null,
        start: { shapeId: A, x: 50, y: 50, via: "binding" },
        end: { shapeId: B, x: 400, y: 50, via: "binding" },
        text: "owns",
        relationId: "rel-1",
        graphSourced: true,
      },
    ]);
    // An arrow is not also a shape; bindings are read, not skipped.
    expect(scene.shapes.map((s) => s.id)).toEqual([A, B]);
    expect(scene.counts.arrows).toBe(1);
    expect(scene.counts.byType).toEqual({ entityCard: 2, arrow: 1 });
    expect(scene.counts.skipped).toEqual({ document: 1, camera: 1 });
  });

  it("pre-2.4 form: a binding kept on the arrow's own terminal is still read", () => {
    const scene = buildBoardScene(
      store(
        ...cards,
        shape("shape:old", "arrow", {
          props: {
            start: {
              type: "binding",
              boundShapeId: A,
              normalizedAnchor: { x: 1, y: 0.5 },
              isExact: false,
            },
            end: { type: "point", x: 700, y: 80 },
            text: "",
          },
        })
      )
    );
    expect(scene.arrows[0]).toMatchObject({
      start: { shapeId: A, x: 100, y: 50, via: "legacy-terminal" },
      end: { shapeId: null, x: 700, y: 80, via: "point" },
    });
    expect(scene.arrows[0]!.text).toBeUndefined();
  });

  it("a free end is a point in page space; an end bound to a missing shape keeps its id", () => {
    const scene = buildBoardScene(
      store(
        shape("shape:free", "arrow", {
          x: 10,
          y: 20,
          props: { start: { x: 0, y: 0 }, end: { x: 30, y: 40 } },
        }),
        {
          typeName: "binding",
          id: "binding:gone",
          type: "arrow",
          fromId: "shape:free",
          toId: "shape:deleted",
          props: { terminal: "end", normalizedAnchor: { x: 0.5, y: 0.5 } },
        }
      )
    );
    expect(scene.arrows[0]).toMatchObject({
      start: { shapeId: null, x: 10, y: 20, via: "point" },
      end: { shapeId: "shape:deleted", x: null, y: null, via: "binding" },
    });
  });
});

describe("buildBoardScene: old props, unknown records, bad input", () => {
  it("a legacy synap-frame and a shape with old or missing props are read, not guessed", () => {
    const scene = buildBoardScene(
      store(
        shape("shape:legacy-frame", "synap-frame", {
          props: { w: 800, h: 600, title: "Section", index: 0 },
        }),
        // An old entity card: no w/h, entityId of the wrong type, no meta.
        {
          typeName: "shape",
          id: "shape:old-card",
          type: "entityCard",
          parentId: "shape:legacy-frame",
          x: 12,
          y: "34",
          props: { entityId: 42, title: "Old" },
        },
        // A view shape from before `referenceMode`, with no viewType.
        shape("shape:old-view", "view", {
          props: { w: 600, h: 400, viewId: "v-1" },
        })
      )
    );
    const byId = Object.fromEntries(scene.shapes.map((s) => [s.id, s]));
    expect(byId["shape:legacy-frame"]!.title).toBe("Section");
    expect(byId["shape:old-card"]).toEqual({
      id: "shape:old-card",
      type: "entityCard",
      parentId: "shape:legacy-frame",
      pageId: PAGE,
      frameId: "shape:legacy-frame",
      x: 12,
      y: 0,
      w: null,
      h: null,
      rotation: 0,
      title: "Old",
    });
    expect(byId["shape:old-view"]!.refs).toEqual({ viewId: "v-1" });
    // The unsized card does not stretch the box.
    expect(scene.bounds).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });

  it("an unknown record type, another binding type and a non-object are skipped and counted", () => {
    const scene = buildBoardScene({
      "custom:1": { typeName: "comment", id: "custom:1" },
      "binding:x": {
        typeName: "binding",
        id: "binding:x",
        type: "sticker",
        fromId: "a",
        toId: "b",
      },
      junk: 7,
      "shape:no-type": { typeName: "shape", id: "shape:no-type" },
      "asset:img": { typeName: "asset", id: "asset:img", type: "image" },
      "shape:geo": shape("shape:geo", "geo", {
        props: { w: 10, h: 10, geo: "rectangle", text: "box" },
      }),
    });
    expect(scene.counts.skipped).toEqual({
      comment: 1,
      "binding:sticker": 1,
      invalid: 2,
      asset: 1,
    });
    expect(scene.shapes.map((s) => [s.id, s.text])).toEqual([
      ["shape:geo", "box"],
    ]);
  });

  it("draw and line shapes get a size from their points", () => {
    const scene = buildBoardScene(
      store(
        shape("shape:draw", "draw", {
          props: {
            segments: [
              {
                type: "free",
                points: [
                  { x: 0, y: 0, z: 0.5 },
                  { x: 40, y: 10, z: 0.5 },
                ],
              },
            ],
          },
        }),
        shape("shape:line", "line", {
          x: 100,
          props: {
            points: {
              a1: { id: "a1", index: "a1", x: 0, y: 0 },
              a2: { id: "a2", index: "a2", x: 0, y: 25 },
            },
          },
        })
      )
    );
    const byId = Object.fromEntries(scene.shapes.map((s) => [s.id, s]));
    expect([byId["shape:draw"]!.w, byId["shape:draw"]!.h]).toEqual([40, 10]);
    expect([byId["shape:line"]!.w, byId["shape:line"]!.h]).toEqual([0, 25]);
  });

  it("long text is capped and marked", () => {
    const scene = buildBoardScene(
      store(
        shape("shape:note", "note", {
          props: { text: "x".repeat(BOARD_TEXT_MAX_CHARS + 5) },
        })
      )
    );
    expect(scene.shapes[0]!.text).toHaveLength(BOARD_TEXT_MAX_CHARS);
    expect(scene.shapes[0]!.textTruncated).toBe(true);
  });

  it("a parent cycle does not hang and keeps local coordinates", () => {
    const scene = buildBoardScene(
      store(
        shape("shape:p", "group", { parentId: "shape:q", x: 1, y: 1 }),
        shape("shape:q", "group", { parentId: "shape:p", x: 2, y: 2 })
      )
    );
    expect(scene.shapes).toHaveLength(2);
  });

  it("an empty store is an empty scene; a non-object input is one invalid skip", () => {
    expect(buildBoardScene({})).toEqual({
      pages: [],
      shapes: [],
      arrows: [],
      counts: { records: 0, shapes: 0, arrows: 0, byType: {}, skipped: {} },
      bounds: null,
    });
    expect(buildBoardScene("nope").counts.skipped).toEqual({ invalid: 1 });
  });
});

describe("windowBoardScene: reading a big board in parts", () => {
  const scene = buildBoardScene(
    store(
      shape("shape:f", "frame", {
        x: 0,
        y: 0,
        props: { w: 500, h: 500, name: "F" },
      }),
      shape("shape:in1", "sticky", {
        parentId: "shape:f",
        x: 10,
        y: 10,
        props: { w: 10, h: 10, content: "1" },
      }),
      shape("shape:nested", "frame", {
        parentId: "shape:f",
        x: 100,
        y: 100,
        props: { w: 100, h: 100, name: "N" },
      }),
      shape("shape:deep", "sticky", {
        parentId: "shape:nested",
        x: 5,
        y: 5,
        props: { w: 10, h: 10, content: "2" },
      }),
      shape("shape:out", "sticky", {
        x: 900,
        y: 900,
        props: { w: 10, h: 10, content: "3" },
      }),
      shape("shape:arr", "arrow", {
        props: { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } },
      }),
      {
        typeName: "binding",
        id: "binding:1",
        type: "arrow",
        fromId: "shape:arr",
        toId: "shape:deep",
        props: { terminal: "start" },
      },
      {
        typeName: "binding",
        id: "binding:2",
        type: "arrow",
        fromId: "shape:arr",
        toId: "shape:out",
        props: { terminal: "end" },
      }
    )
  );

  it("no window asked: the scene unchanged, no `window`", () => {
    expect(windowBoardScene(scene, {})).toBe(scene);
  });

  it("frameId keeps the frame and what it holds at any depth, and arrows touching it; counts stay whole", () => {
    const w = windowBoardScene(scene, { frameId: "shape:f" });
    expect(w.shapes.map((s) => s.id).sort()).toEqual([
      "shape:deep",
      "shape:f",
      "shape:in1",
      "shape:nested",
    ]);
    expect(w.arrows.map((a) => a.id)).toEqual(["shape:arr"]);
    expect(w.counts.shapes).toBe(5);
    expect(w.window).toEqual({
      frameId: "shape:f",
      offset: 0,
      matched: 4,
      nextOffset: null,
    });
  });

  it("offset/limit page the shapes in reading order and say where the next page starts", () => {
    const p1 = windowBoardScene(scene, { offset: 0, limit: 2 });
    expect(p1.shapes.map((s) => s.id)).toEqual(["shape:f", "shape:in1"]);
    expect(p1.window!.nextOffset).toBe(2);
    expect(p1.arrows).toEqual([]);
    const p3 = windowBoardScene(scene, { offset: 4, limit: 2 });
    expect(p3.shapes.map((s) => s.id)).toEqual(["shape:out"]);
    expect(p3.window!.nextOffset).toBeNull();
    expect(p3.arrows.map((a) => a.id)).toEqual(["shape:arr"]);
  });
});
