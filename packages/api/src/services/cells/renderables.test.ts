import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WIDGET_DEFINITIONS } from "@synap-core/types/renderables";
import { locateEmbeds } from "@synap-core/markdown-core/readable";
import {
  builtinRenderableRows,
  discoverRenderables,
  placeableInstalledKeys,
  renderableArrangeError,
  type RenderableRow,
} from "./renderables.js";

const NONE = new Map<string, readonly string[]>();

/** An installed row as `listRenderables` returns it (no DB in this test). */
function installed(typeKey: string, required: string[] = []): RenderableRow {
  return {
    typeKey,
    name: typeKey,
    description: null,
    rendererType: "frame",
    workspaceId: "ws-1",
    configSchema: { type: "object", properties: {}, required },
    source: "pack",
    placements: ["bento", "inline"],
    dataBinding: null,
    requiredConfig: required,
    aiPlaceable:
      typeKey.startsWith("cell:") || typeKey.startsWith("generated:"),
    aiHint: null,
    fallback: "{name}",
    form: "directive",
    package: null,
  };
}

describe("renderableArrangeError — the arrange gate reads the one catalog", () => {
  it("refuses a key no catalog and no pod row knows", () => {
    expect(
      renderableArrangeError("entity-metric", { profileSlug: "app" }, NONE)
    ).toMatch(/Unknown widget "entity-metric"/);
  });

  it("admits every chart — the 14 keys the old 18-key allowlist refused", () => {
    const charts = WIDGET_DEFINITIONS.filter((d) => d.key.startsWith("chart-"));
    expect(charts.length).toBe(14);
    for (const chart of charts) {
      const config = Object.fromEntries(
        (chart.requiredConfig ?? []).map((k) => [k, "x"])
      );
      expect(
        renderableArrangeError(chart.key, config, NONE),
        chart.key
      ).toBeNull();
    }
  });

  it("names the missing required config", () => {
    expect(
      renderableArrangeError("view-table", { profileSlug: "a" }, NONE)
    ).toMatch(/config\.viewId/);
    expect(
      renderableArrangeError("view-table", { viewId: "v" }, NONE)
    ).toBeNull();
    expect(
      renderableArrangeError("stat-card", { profileSlug: "a" }, NONE)
    ).toBeNull();
  });

  it("refuses a built-in whose required config the catalog has not curated", () => {
    const uncurated = WIDGET_DEFINITIONS.find(
      (d) => d.requiredConfig === undefined
    );
    expect(
      uncurated,
      "fixture: at least one un-curated built-in"
    ).toBeDefined();
    expect(renderableArrangeError(uncurated!.key, {}, NONE)).toMatch(
      /not agent-placeable/
    );
  });

  it("admits a pack cell (cell:<pkg>:<key>) that exists here — refused before W3", () => {
    const rows = [...builtinRenderableRows(), installed("cell:crm:pipeline")];
    const known = placeableInstalledKeys(rows);
    expect(renderableArrangeError("cell:crm:pipeline", {}, known)).toBeNull();
    expect(renderableArrangeError("generated:board", {}, known)).toMatch(
      /Unknown installed cell/
    );
  });

  it("enforces an installed cell's own required config", () => {
    const known = placeableInstalledKeys([
      installed("generated:board", ["profileSlug"]),
    ]);
    expect(renderableArrangeError("generated:board", {}, known)).toMatch(
      /config\.profileSlug/
    );
    expect(
      renderableArrangeError("generated:board", { profileSlug: "task" }, known)
    ).toBeNull();
  });
});

describe("placeableInstalledKeys", () => {
  it("never lists a catalog row, and drops an un-namespaced studio row", () => {
    const rows = [
      ...builtinRenderableRows(),
      installed("generated:a"),
      installed("win-rate-gauge"),
    ];
    expect([...placeableInstalledKeys(rows).keys()]).toEqual(["generated:a"]);
  });
});

describe("discoverRenderables — synap_list_widgets", () => {
  const rows = [...builtinRenderableRows(), installed("cell:crm:pipeline")];

  it("document surface lists charts with the embed grammar", () => {
    const doc = discoverRenderables(rows, "document");
    const bar = doc.find((e) => e.key === "chart-bar");
    expect(bar).toBeDefined();
    expect(bar!.exampleDirective.split("\n")[0]).toBe(
      ':::synap-cell{cellKey="chart-bar"}'
    );
    expect(bar!.exampleDirective).toContain("```json");
    expect(doc.some((e) => e.key === "cell:crm:pipeline" && e.installed)).toBe(
      true
    );
  });

  it("a document chart example is a snapshot (D2); the same chart on a dashboard stays live", () => {
    const docBar = discoverRenderables(rows, "document").find(
      (e) => e.key === "chart-bar"
    )!;
    const bentoBar = discoverRenderables(rows, "bento").find(
      (e) => e.key === "chart-bar"
    )!;
    const props = (ex: string) =>
      JSON.parse(ex.split("\n")[2]!) as Record<string, unknown>;
    expect(props(docBar.exampleDirective)).toMatchObject({
      profileSlug: "<profileSlug>",
      capturedAt: "<ISO date>",
    });
    expect(Array.isArray(props(docBar.exampleDirective).data)).toBe(true);
    expect(props(bentoBar.exampleDirective)).not.toHaveProperty("data");
  });

  it("never lists aliases or un-placeable entries", () => {
    for (const surface of ["document", "bento"] as const) {
      const keys = new Set(
        discoverRenderables(rows, surface).map((e) => e.key)
      );
      expect(keys.size).toBeGreaterThan(20);
      for (const def of WIDGET_DEFINITIONS) {
        if (def.aliasOf || def.requiredConfig === undefined) {
          expect(keys.has(def.key), `${surface}: ${def.key}`).toBe(false);
        }
      }
    }
  });

  it("every example reads back through the one embed reader (installed keys too)", () => {
    const doc = discoverRenderables(rows, "document");
    expect(doc.length).toBeGreaterThan(20);
    for (const entry of doc) {
      const [one, ...rest] = locateEmbeds(entry.exampleDirective);
      expect(rest, entry.key).toEqual([]);
      expect(one?.embed.ref.cellKey, entry.key).toBe(entry.key);
      expect(one?.embed.propsError, entry.key).toBeUndefined();
      expect(one?.embed.legacy, entry.key).toBeFalsy();
      expect(one?.fallbackRange, entry.key).not.toBeNull();
    }
  });

  it("bento entries carry a default size; document entries do not", () => {
    expect(discoverRenderables(rows, "bento")[0]).toHaveProperty("defaultSize");
    expect(discoverRenderables(rows, "document")[0]).not.toHaveProperty(
      "defaultSize"
    );
  });
});

describe("builtinRenderableRows", () => {
  it("is the whole catalog, marked source=catalog", () => {
    const rows = builtinRenderableRows();
    expect(rows.length).toBe(WIDGET_DEFINITIONS.length);
    expect(rows.every((r) => r.source === "catalog")).toBe(true);
  });
});

describe("app-surface widgets (generation contract rule 12)", () => {
  const APP_SURFACE = [
    "greeting",
    "home-tabs",
    "workspace-info",
    "quick-access",
    "ai-chat",
  ];

  it("synap_list_widgets never offers them on a document", () => {
    const doc = discoverRenderables(builtinRenderableRows(), "document").map(
      (e) => e.key
    );
    for (const key of APP_SURFACE) expect(doc, key).not.toContain(key);
  });

  it("their rows keep the bento placement only", () => {
    const rows = builtinRenderableRows();
    for (const key of APP_SURFACE) {
      const row = rows.find((r) => r.typeKey === key);
      expect(row, key).toBeDefined();
      expect(row!.placements, key).toEqual(["bento"]);
    }
  });
});

describe("work-state widgets — what synap_list_widgets offers on a document", () => {
  const doc = discoverRenderables(builtinRenderableRows(), "document");
  const entry = (key: string) => doc.find((e) => e.key === key);

  it("offers the three work-state cells and the four work cells", () => {
    for (const key of [
      "lens-section",
      "work-release",
      "status-mark",
      "active-sessions",
      "agent-runs",
      "agent-spend",
      "session-goal-bar",
    ]) {
      const e = entry(key);
      expect(e, key).toBeDefined();
      expect(e!.aiHint, key).toBeTruthy();
      expect(e!.exampleDirective.split("\n")[0], key).toBe(
        `:::synap-cell{cellKey="${key}"}`
      );
    }
  });

  it("lens-section's props schema holds the design constraints an agent reads", () => {
    const schema = z.fromJSONSchema(
      entry("lens-section")!.propsSchema as Parameters<
        typeof z.fromJSONSchema
      >[0]
    );
    expect(schema.safeParse({ section: "blocking" }).success).toBe(true);
    expect(
      schema.safeParse({ section: "happened", limit: 10, empty: "reassure" })
        .success
    ).toBe(true);
    expect(schema.safeParse({ section: "blocking", limit: 11 }).success).toBe(
      false
    );
    expect(schema.safeParse({ section: "blocking", limit: 0 }).success).toBe(
      false
    );
    expect(schema.safeParse({ section: "blocking", limit: 2.5 }).success).toBe(
      false
    );
    expect(schema.safeParse({ section: "needs-you" }).success).toBe(false);
    // A section the lens page read does not carry is refused at write time.
    expect(schema.safeParse({ section: "structure" }).success).toBe(false);
    expect(schema.safeParse({ section: "doneWhen" }).success).toBe(false);
    expect(
      schema.safeParse({ section: "blocking", empty: "blank" }).success
    ).toBe(false);
    // INVITE needs an action a block cannot offer: refused at write time.
    expect(
      schema.safeParse({ section: "blocking", empty: "invite" }).success
    ).toBe(false);
    expect(schema.safeParse({ limit: 3 }).success).toBe(false);
  });

  it("the arrange gate asks for what each cannot render without", () => {
    expect(renderableArrangeError("lens-section", {}, NONE)).toMatch(
      /needs config\.section/
    );
    expect(renderableArrangeError("status-mark", {}, NONE)).toMatch(
      /needs config\.id/
    );
    expect(renderableArrangeError("session-goal-bar", {}, NONE)).toMatch(
      /needs config\.sessionId/
    );
    for (const key of [
      "work-release",
      "active-sessions",
      "agent-runs",
      "agent-spend",
    ])
      expect(renderableArrangeError(key, {}, NONE), key).toBe(null);
  });
});
