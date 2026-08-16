import { describe, expect, it } from "vitest";
import {
  COMPOSE_WIDGET_CATALOG,
  composeCatalogAsDefinitionRows,
  composeWidgetError,
} from "./compose-widget-catalog.js";

describe("compose widget catalog", () => {
  it("rejects invented keys the Browser does not register", () => {
    expect(composeWidgetError("entity-metric", { profileSlug: "app" })).toMatch(
      /Unknown widget/
    );
  });

  it("rejects view-table without a saved viewId", () => {
    const err = composeWidgetError("view-table", {
      profileSlug: "devplane_app",
    });
    expect(err).toMatch(/viewId/);
    expect(err).not.toBeNull();
  });

  it("accepts view-table with a viewId", () => {
    expect(
      composeWidgetError("view-table", {
        viewId: "57d3c9a4-b4a1-46f7-ac20-644e22c8e630",
      })
    ).toBeNull();
  });

  it("accepts stat-card with profileSlug and treats entity-count as the same", () => {
    expect(
      composeWidgetError("stat-card", { profileSlug: "devplane_app" })
    ).toBeNull();
    expect(
      composeWidgetError("entity-count", { profileSlug: "devplane_app" })
    ).toBeNull();
  });

  it("accepts generated cells that are already on the pod", () => {
    const known = new Set(["generated:product-development-board"]);
    expect(
      composeWidgetError("generated:product-development-board", {}, known)
    ).toBeNull();
    expect(composeWidgetError("generated:missing-thing", {}, known)).toMatch(
      /Unknown generated cell/
    );
  });

  it("emits synthetic definition rows covering every catalog key", () => {
    const rows = composeCatalogAsDefinitionRows();
    const keys = new Set(rows.map((r) => r.typeKey));
    for (const widget of COMPOSE_WIDGET_CATALOG) {
      expect(keys.has(widget.key)).toBe(true);
    }
    expect(rows.find((r) => r.typeKey === "stat-card")?.source).toBe(
      "compose-catalog"
    );
  });
});
