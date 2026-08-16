import { describe, expect, it } from "vitest";
import {
  getConfigSchemaForViewType,
  validateViewConfig,
} from "./config-schemas.js";

describe("Bento view config — agent-authored blocks survive the create gate", () => {
  it("accepts the widget/view block shape views.create stores on a proposal", () => {
    expect(
      validateViewConfig("bento", {
        layout: "bento",
        blocks: [
          {
            id: "pd-header",
            kind: "widget",
            widgetType: "section-header",
            pos: { x: 0, y: 0, w: 12, h: 2 },
            config: { title: "Product development" },
          },
          {
            id: "pd-apps",
            kind: "view",
            viewId: "57d3c9a4-b4a1-46f7-ac20-644e22c8e630",
            pos: { x: 0, y: 4, w: 6, h: 8 },
          },
        ],
      }).valid
    ).toBe(true);
  });

  it("rejects an empty object so a stripped proposal cannot look valid", () => {
    expect(validateViewConfig("bento", {}).valid).toBe(false);
  });
});

describe("Sheet view config schema", () => {
  it("registers the Sheet render schema on the API config-validation door", () => {
    expect(getConfigSchemaForViewType("sheet")).not.toBeNull();
    expect(
      validateViewConfig("sheet", {
        sheetSurface: "canvas",
        sheetBlocks: [
          {
            id: "primary-table",
            kind: "table",
            source: "current-view",
            position: { x: 0, y: 0, w: 9, h: 11 },
          },
        ],
      }).valid
    ).toBe(true);
  });

  it("rejects an invalid Sheet block position before a view config is written", () => {
    expect(
      validateViewConfig("sheet", {
        sheetBlocks: [
          {
            id: "outside-canvas",
            kind: "note",
            content: "Invalid",
            position: { x: -1, y: 0, w: 4, h: 4 },
          },
        ],
      }).valid
    ).toBe(false);
  });

  it("accepts global axis dimensions but rejects ambiguous placement writes", () => {
    expect(
      validateViewConfig("sheet", {
        sheetGridDimensions: {
          columnWidths: { 0: 240, 5: 180 },
          rowHeights: { 2: 56 },
        },
      }).valid
    ).toBe(true);
    expect(
      validateViewConfig("sheet", {
        sheetBlocks: [
          {
            id: "ambiguous-placement",
            kind: "note",
            content: "Never persist two coordinate systems",
            range: {
              start: { row: 0, column: 0 },
              end: { row: 1, column: 1 },
            },
            position: { x: 3, y: 3, w: 2, h: 2 },
          },
        ],
      }).valid
    ).toBe(false);
  });
});
