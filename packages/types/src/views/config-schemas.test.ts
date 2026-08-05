import { describe, expect, it } from "vitest";
import {
  getConfigSchemaForViewType,
  validateViewConfig,
} from "./config-schemas.js";

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
});
