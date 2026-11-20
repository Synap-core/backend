/**
 * The one renderer resolution. Every case of `RENDERER_RESOLUTION_CASES`
 * runs through `resolveObjectRenderer` here; each host runs the same cases
 * through its own adapter in its own repo (reachability, not shape).
 */
import { describe, expect, it } from "vitest";
import {
  PREFER_LOCAL_FALLBACK_OVER_SYSTEM_DEFAULT,
  RENDERER_RESOLUTION_CASES,
  pickEffectiveRenderer,
  readBoundViewCellKey,
  rendererResolutionCaseArgs,
  resolveEntityRendererOverride,
  resolveObjectRenderer,
} from "./index.js";

describe("RENDERER_RESOLUTION_CASES", () => {
  it("covers every slot and every way a renderer is chosen", () => {
    const subjects = new Set(
      RENDERER_RESOLUTION_CASES.map((c) =>
        c.input.subject.kind === "view" ? "view" : c.input.subject.slot
      )
    );
    expect([...subjects].sort()).toEqual([
      "entity-card",
      "entity-detail",
      "view",
    ]);
    const vias = new Set(
      RENDERER_RESOLUTION_CASES.map((c) =>
        c.expected.kind === "cell" ? c.expected.via : c.expected.kind
      )
    );
    expect([...vias].sort()).toEqual(
      [
        "binding",
        "builtin",
        "entity-override",
        "host-fallback",
        "none",
        "system-default",
        "view-binding",
      ].sort()
    );
    expect(RENDERER_RESOLUTION_CASES.some((c) => c.expected.readFailed)).toBe(
      true
    );
    const names = RENDERER_RESOLUTION_CASES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const c of RENDERER_RESOLUTION_CASES) {
    it(c.name, () => {
      expect(
        resolveObjectRenderer(rendererResolutionCaseArgs(c.input))
      ).toEqual(c.expected);
    });
  }
});

describe("the parts each host re-exports", () => {
  it("pickEffectiveRenderer: an explicit binding always wins", () => {
    const bound = { kind: "cell", cellKey: "a" };
    const local = { kind: "cell", cellKey: "local" };
    for (const source of ["workspace", "profile"])
      expect(
        pickEffectiveRenderer(
          { "entity-detail": bound, sources: { "entity-detail": source } },
          "entity-detail",
          () => local
        )
      ).toBe(bound);
  });

  it("pickEffectiveRenderer: a system default yields to the local fallback on a source-aware slot only", () => {
    expect(PREFER_LOCAL_FALLBACK_OVER_SYSTEM_DEFAULT).toBe(true);
    const def = { kind: "cell", cellKey: "default" };
    const local = { kind: "cell", cellKey: "local" };
    const answer = (slot: string) => ({
      [slot]: def,
      sources: { [slot]: "default" },
    });
    expect(
      pickEffectiveRenderer(
        answer("entity-detail"),
        "entity-detail",
        () => local
      )
    ).toBe(local);
    expect(
      pickEffectiveRenderer(answer("entity-card"), "entity-card", () => local)
    ).toBe(local);
    expect(
      pickEffectiveRenderer(answer("collection"), "collection", () => local)
    ).toBe(def);
    expect(
      pickEffectiveRenderer(
        answer("entity-detail"),
        "entity-detail",
        () => null
      )
    ).toBe(def);
    expect(pickEffectiveRenderer(undefined, "entity-detail", () => null)).toBe(
      null
    );
    expect(pickEffectiveRenderer({}, "entity-detail", () => local)).toBe(local);
  });

  it("resolveEntityRendererOverride: only a cell ref with a key counts", () => {
    expect(resolveEntityRendererOverride(undefined)).toBe(null);
    expect(resolveEntityRendererOverride({ systemData: null })).toBe(null);
    expect(
      resolveEntityRendererOverride({
        systemData: { renderer: { kind: "view", viewId: "v" } },
      })
    ).toBe(null);
    expect(
      resolveEntityRendererOverride({
        systemData: { renderer: { kind: "cell", cellKey: "" } },
      })
    ).toBe(null);
    expect(
      resolveEntityRendererOverride({
        systemData: {
          renderer: { kind: "cell", cellKey: "k", props: [1], title: "T" },
        },
      })
    ).toEqual({ kind: "cell", cellKey: "k", props: {}, title: "T" });
  });

  it("readBoundViewCellKey: only a cell rendererRef", () => {
    expect(readBoundViewCellKey(undefined)).toBe(undefined);
    expect(
      readBoundViewCellKey({ rendererRef: { kind: "cell", cellKey: "b" } })
    ).toBe("b");
    expect(
      readBoundViewCellKey({
        rendererRef: { kind: "view-adapter", adapterKey: "b" },
      })
    ).toBe(undefined);
    expect(
      readBoundViewCellKey({ rendererRef: { kind: "cell", cellKey: 3 } })
    ).toBe(undefined);
  });
});
