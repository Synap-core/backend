import { describe, expect, it } from "vitest";
import {
  FENCE_RENDERABLES,
  FENCE_RENDERABLE_KEYS,
  WIDGET_BY_KEY,
  fenceRenderableFor,
} from "./index.js";

describe("fence renderables (form: fence)", () => {
  it("one row per key, every row a fence placed inline", () => {
    expect(FENCE_RENDERABLES.map((d) => d.key)).toEqual([
      ...FENCE_RENDERABLE_KEYS,
    ]);
    for (const def of FENCE_RENDERABLES) {
      expect(def.form).toBe("fence");
      expect(def.placements).toContain("inline");
      expect(def.aiHint.length).toBeGreaterThan(20);
    }
  });

  it("selects by the info string's first word, case-insensitive", () => {
    expect(fenceRenderableFor("mermaid").key).toBe("mermaid");
    expect(fenceRenderableFor("Mermaid title=x").key).toBe("mermaid");
    expect(fenceRenderableFor("math").key).toBe("math");
    expect(fenceRenderableFor("latex").key).toBe("math");
  });

  it("every other fence, including none, is code", () => {
    for (const lang of ["ts", "json", "", undefined, null, "chart"]) {
      expect(fenceRenderableFor(lang).key).toBe("code");
    }
  });

  it("no fence row shadows a widget key (a chart is a directive, never a fence)", () => {
    for (const def of FENCE_RENDERABLES) {
      expect(
        WIDGET_BY_KEY[def.key as keyof typeof WIDGET_BY_KEY]
      ).toBeUndefined();
      for (const lang of def.languages) expect(lang).not.toMatch(/^chart/);
    }
  });
});
