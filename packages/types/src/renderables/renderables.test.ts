import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILTIN_PACKAGE_IDS,
  CONTENT_KINDS,
  VIEW_DEFINITIONS,
  VIEW_TYPE_KEYS,
  WIDGET_BY_KEY,
  WIDGET_DEFINITIONS,
  WIDGET_TYPE_KEYS,
  configFieldsToJsonSchema,
  exampleEmbedProps,
  fallbackFor,
  isAiPlaceable,
  isBuiltinRenderableKey,
  isDocumentEmbeddable,
  isInstalledRenderableKey,
  missingRequiredConfig,
  renderRenderableFallback,
  requiredConfigFor,
} from "./index.js";

describe("renderables catalog", () => {
  it("every catalog widget key is a declared WidgetTypeKey", () => {
    expect(WIDGET_DEFINITIONS.length).toBeGreaterThan(70);
    const declared = new Set<string>(WIDGET_TYPE_KEYS);
    for (const def of WIDGET_DEFINITIONS) expect(declared).toContain(def.key);
  });

  it("the only declared keys WITHOUT a catalog entry are the known uncatalogued three", () => {
    // capture-flow is registered but never offered; welcome/welcome-header are
    // retired (saved templates still name them). A new key must get an entry.
    const uncatalogued = WIDGET_TYPE_KEYS.filter((k) => !WIDGET_BY_KEY[k]);
    expect([...uncatalogued].sort()).toEqual(
      ["capture-flow", "welcome", "welcome-header"].sort()
    );
  });

  it("every view definition key is a declared ViewTypeKey and vice versa", () => {
    expect(VIEW_DEFINITIONS.map((v) => v.key).sort()).toEqual(
      [...VIEW_TYPE_KEYS].sort()
    );
  });

  it("aliases point at a real catalog entry", () => {
    for (const def of WIDGET_DEFINITIONS) {
      if (def.aliasOf) expect(WIDGET_BY_KEY[def.aliasOf]).toBeDefined();
    }
  });

  it("package fields name a real built-in package", () => {
    const ids = new Set<string>(BUILTIN_PACKAGE_IDS);
    const withPackage = WIDGET_DEFINITIONS.filter((d) => d.package);
    expect(withPackage.length).toBeGreaterThan(60);
    for (const def of withPackage) expect(ids).toContain(def.package);
  });

  it("curated requiredConfig keys are real config fields (catches typos)", () => {
    const curated = WIDGET_DEFINITIONS.filter(isAiPlaceable);
    // The 18 keys the old compose catalog admitted must all stay placeable.
    for (const key of [
      "section-header",
      "stat-card",
      "entity-count",
      "entity-list",
      "entity-gallery",
      "entity-card",
      "entity-spotlight",
      "view",
      "view-table",
      "view-list",
      "view-kanban",
      "view-calendar",
      "view-grid",
      "feed",
      "inbox",
      "quick-access",
      "calendar",
      "proposals-list",
    ]) {
      expect(curated.map((d) => d.key)).toContain(key);
    }
    for (const def of curated) {
      const fields = new Set(def.configSchema.map((f) => f.key));
      for (const key of requiredConfigFor(def)) {
        expect(fields, `${def.key}.requiredConfig names "${key}"`).toContain(
          key
        );
      }
    }
  });

  it("every chart is AI-placeable and document-embeddable", () => {
    const charts = WIDGET_DEFINITIONS.filter((d) => d.key.startsWith("chart-"));
    expect(charts.length).toBe(14);
    for (const c of charts) {
      expect(isAiPlaceable(c)).toBe(true);
      expect(isDocumentEmbeddable(c)).toBe(true);
    }
  });

  it("requiredConfig: explicit wins; otherwise the schema's required fields", () => {
    expect(requiredConfigFor(WIDGET_BY_KEY["view"]!)).toEqual(["viewId"]);
    expect(requiredConfigFor(WIDGET_BY_KEY["ai-doc-proposal"]!)).toEqual([
      "title",
    ]);
    expect(
      missingRequiredConfig(WIDGET_BY_KEY["view-table"]!, { profileSlug: "x" })
    ).toEqual(["viewId"]);
    expect(
      missingRequiredConfig(WIDGET_BY_KEY["view-table"]!, { viewId: "v" })
    ).toEqual([]);
    expect(
      missingRequiredConfig(WIDGET_BY_KEY["stat-card"]!, { profileSlug: "" })
    ).toEqual(["profileSlug"]);
  });
});

describe("fallback templates", () => {
  it("fills name and props, trims orphaned separators, never returns blank", () => {
    expect(
      renderRenderableFallback("{name}: {props.label}", {
        name: "Bar Chart",
        props: { label: "Backlog" },
      })
    ).toBe("Bar Chart: Backlog");
    expect(
      renderRenderableFallback("{name}: {props.label}", { name: "Bar Chart" })
    ).toBe("Bar Chart");
    expect(
      renderRenderableFallback("{props.missing}", { name: "Bar Chart" })
    ).toBe("Bar Chart");
    expect(
      renderRenderableFallback("{props.n} open", { name: "X", props: { n: 3 } })
    ).toBe("3 open");
    expect(
      renderRenderableFallback("{props.obj}", {
        name: "X",
        props: { obj: { a: 1 } },
      })
    ).toBe("X");
  });

  it("every catalog entry renders a non-empty fallback", () => {
    for (const def of WIDGET_DEFINITIONS)
      expect(fallbackFor(def).length).toBeGreaterThan(0);
  });
});

describe("example embed props (document grammar, plan §3)", () => {
  it("are the required keys as placeholders, plus a label when the cell takes one", () => {
    expect(exampleEmbedProps(WIDGET_BY_KEY["chart-live-line"]!)).toEqual({
      profileSlug: "<profileSlug>",
      label: "<label>",
    });
  });

  it("are plain data for every catalog widget (the directive is serializeEmbed's)", () => {
    for (const def of WIDGET_DEFINITIONS) {
      const props = exampleEmbedProps(def);
      expect(JSON.parse(JSON.stringify(props)), def.key).toEqual(props);
    }
  });
});

describe("configFieldsToJsonSchema", () => {
  it("emits only valid JSON Schema types for every catalog field", () => {
    const valid = new Set(["string", "number", "boolean", "object", "array"]);
    let seen = 0;
    for (const def of WIDGET_DEFINITIONS) {
      const schema = configFieldsToJsonSchema(
        def.configSchema,
        requiredConfigFor(def)
      );
      for (const [key, prop] of Object.entries(schema.properties)) {
        seen++;
        expect(valid, `${def.key}.${key}`).toContain(prop.type);
      }
    }
    expect(seen).toBeGreaterThan(200);
  });

  it("carries the curated required list even when the schema lacks the field", () => {
    const schema = configFieldsToJsonSchema([], ["viewId"]);
    expect(schema.required).toEqual(["viewId"]);
    expect(schema.properties.viewId).toEqual({ type: "string" });
  });
});

describe("key namespaces", () => {
  it("built-in keys are reserved; installed keys are namespaced", () => {
    expect(isBuiltinRenderableKey("chart-bar")).toBe(true);
    expect(isBuiltinRenderableKey("welcome")).toBe(true);
    expect(isBuiltinRenderableKey("cell:pack:thing")).toBe(false);
    expect(isInstalledRenderableKey("cell:pack:thing")).toBe(true);
    expect(isInstalledRenderableKey("generated:board")).toBe(true);
    expect(isInstalledRenderableKey("chart-bar")).toBe(false);
  });
});

describe("leaf subpath", () => {
  it("imports nothing but its own relative files (no zod, drizzle, react)", () => {
    const dir = import.meta.dirname;
    const files = readdirSync(dir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts")
    );
    expect(files.length).toBeGreaterThanOrEqual(6);
    let imports = 0;
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(
        /^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gm
      )) {
        imports++;
        expect(m[1], `${f} imports ${m[1]}`).toMatch(/^\.\//);
      }
    }
    expect(imports).toBeGreaterThan(5);
  });

  it("keeps the content-kind taxonomy", () => {
    expect([...CONTENT_KINDS]).toContain("widget");
  });
});
