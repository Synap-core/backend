/**
 * The catalog snapshot as the pod reads it: a snapshot it cannot trust is
 * refused, never read as an empty catalog.
 */
import { describe, expect, it } from "vitest";
import {
  catalogSchema,
  composeAppCatalog,
  readDesignCatalog,
  readKitCatalog,
} from "./catalog.js";

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

  it("refuses a component that declares span, start or hide itself (every block has them)", () => {
    expect(
      readDesignCatalog({
        ...good,
        components: { X: { span: { kind: "number" } } },
      })
    ).toMatchObject({ ok: false, error: expect.stringMatching(/span/) });
    expect(
      readDesignCatalog({
        ...good,
        components: { X: { start: { kind: "slot" } } },
      })
    ).toMatchObject({ ok: false, error: expect.stringMatching(/`start`/) });
  });
});

const sha = (c: string) => c.repeat(64);
const kit = {
  kitId: "crm",
  hash: "sha256:k1",
  components: {
    Button: {
      variant: { kind: "select", options: ["default", "outline"] },
      children: { kind: "slot" },
    },
  },
  layout: {},
  canvas: { components: { Button: { category: "button", defaults: {} } } },
  kit: {
    react: "19",
    files: {
      js: {
        entityId: "0b6f2a4e-3c1d-4e5f-8a9b-0c1d2e3f4a5b",
        sha256: sha("a"),
        bytes: 10,
      },
      css: {
        entityId: "1b6f2a4e-3c1d-4e5f-8a9b-0c1d2e3f4a5b",
        sha256: sha("b"),
        bytes: 20,
      },
    },
  },
};

describe("readKitCatalog (a client app's kit)", () => {
  it("reads the kit with its React major, its two pinned files and its canvas block", () => {
    const r = readKitCatalog(kit);
    if (!r.ok) throw new Error(r.error);
    expect(r.catalog.kit.files.js.sha256).toBe(sha("a"));
    expect(r.catalog.kit.react).toBe("19");
    expect(r.catalog.canvas.components).toHaveProperty("Button");
  });

  it("refuses Synap's id, canvas blocks of its own, an unpublished file, no React, a component with no canvas entry", () => {
    expect(readKitCatalog({ ...kit, kitId: "synap" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Synap's own kit/),
    });
    expect(readKitCatalog({ ...kit, layout: { Stack: {} } })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no canvas blocks/),
    });
    expect(
      readKitCatalog({
        ...kit,
        kit: {
          ...kit.kit,
          files: {
            ...kit.kit.files,
            js: { sha256: sha("a"), bytes: 1, entityId: null },
          },
        },
      })
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/js file is not published/),
    });
    expect(
      readKitCatalog({ ...kit, kit: { ...kit.kit, react: "^19.3.0" } })
    ).toMatchObject({ ok: false, error: expect.stringMatching(/React major/) });
    expect(
      readKitCatalog({ ...kit, canvas: { components: {} } })
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no entry for Button/),
    });
    expect(readKitCatalog({ ...kit, hash: "" })).toMatchObject({ ok: false });
  });

  it("composes with Synap's canvas blocks: the kit's components, Synap's layout, a hash naming both", () => {
    const synap = readDesignCatalog(good);
    const k = readKitCatalog(kit);
    if (!synap.ok || !k.ok) throw new Error("fixtures");
    const app = composeAppCatalog(synap.catalog, k.catalog);
    if (!app.ok) throw new Error(app.error);
    expect(app.catalog.kitId).toBe("crm");
    expect(app.catalog.hash).toBe("sha256:k1+h-1");
    expect(Object.keys(catalogSchema(app.catalog)).sort()).toEqual([
      "Button",
      "Stack",
    ]);
    expect(app.catalog.components).not.toHaveProperty("SpatialButton");
  });

  it("refuses a kit component named like a canvas block", () => {
    const synap = readDesignCatalog(good);
    const k = readKitCatalog({
      ...kit,
      components: { Stack: {} },
      canvas: { components: { Stack: {} } },
    });
    if (!synap.ok || !k.ok) throw new Error("fixtures");
    expect(composeAppCatalog(synap.catalog, k.catalog)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/both as a component and as a canvas block/),
    });
  });
});
