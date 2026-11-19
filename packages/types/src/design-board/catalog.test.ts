/**
 * The catalog snapshot as the pod reads it: a snapshot it cannot trust is
 * refused, never read as an empty catalog.
 */
import { describe, expect, it } from "vitest";
import { catalogSchema, readDesignCatalog } from "./catalog.js";

const good = {
  kitId: "synap",
  hash: "h-1",
  components: {
    SpatialButton: {
      variant: { kind: "select", options: ["primary"] },
      children: { kind: "slot" },
    },
  },
  layout: {
    Stack: {
      gap: { kind: "select", options: ["space-100"] },
      children: { kind: "slot" },
    },
  },
};

describe("readDesignCatalog", () => {
  it("reads a snapshot, and its schema is the canvas blocks plus the kit's components", () => {
    const r = readDesignCatalog(good);
    if (!r.ok) throw new Error(r.error);
    expect(Object.keys(catalogSchema(r.catalog)).sort()).toEqual([
      "SpatialButton",
      "Stack",
    ]);
  });

  it("refuses no kit, no hash, a prop spec of an unknown kind, and a name in both halves", () => {
    expect(readDesignCatalog(null)).toMatchObject({ ok: false });
    expect(readDesignCatalog({ ...good, kitId: "" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/kit/),
    });
    expect(readDesignCatalog({ ...good, hash: undefined })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/hash/),
    });
    expect(
      readDesignCatalog({
        ...good,
        components: { X: { p: { kind: "colour" } } },
      })
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/components\.X\.p/),
    });
    expect(
      readDesignCatalog({
        ...good,
        components: { ...good.components, Stack: {} },
      })
    ).toMatchObject({ ok: false, error: expect.stringMatching(/both/) });
  });

  it("refuses a component that declares span or hide itself (every block has them)", () => {
    expect(
      readDesignCatalog({
        ...good,
        components: { X: { span: { kind: "number" } } },
      })
    ).toMatchObject({ ok: false, error: expect.stringMatching(/span/) });
  });
});
