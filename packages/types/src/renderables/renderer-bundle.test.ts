/**
 * The renderer-bundle definition's pure check (`validateRendererBundleDefinition`).
 */
import { describe, expect, it } from "vitest";
import {
  RENDERER_BUNDLE_MAX_MODULE_BYTES,
  validateRendererBundleDefinition,
  type RendererBundleDefinition,
} from "./index.js";

const SHA = "a".repeat(64);
const mod = (source: string) => ({ source, sha256: SHA });

function bundle(): RendererBundleDefinition {
  return {
    _meta: {
      slug: "synap-renderers",
      version: "1.0.0",
      kind: "renderer-bundle",
    },
    bundleApi: 1,
    reactVersion: "19.2.3",
    setSha256: SHA,
    kitExports: ["Card", "Board"],
    hostModules: {
      react: mod("export default {};"),
      reactDom: mod("export default {};"),
      reactDomClient: mod("export const createRoot = () => null;"),
      jsxRuntime: mod("export const jsx = () => null;"),
      kit: mod("export const Card = () => null;"),
      tokensCss: mod(":root{}"),
    },
    cells: [
      {
        key: "entity-card",
        name: "Entity card",
        code: 'import { Card } from "@synap/kit";\nexport default function C() { return null; }',
        sha256: SHA,
        contentKind: "entity-card",
        kitImports: ["Card"],
      },
      {
        key: "board",
        name: "Board",
        code: 'import { Board } from "@synap/kit";\nexport default function B() { return null; }',
        sha256: SHA,
        contentKind: "collection",
        viewTypes: ["board", "kanban"],
        defaultSize: { w: 12, h: 8 },
        kitImports: ["Board"],
      },
    ],
    defaults: { "entity-card": "entity-card", views: { board: "board" } },
  };
}

const paths = (d: unknown) =>
  validateRendererBundleDefinition(d).map((p) => p.path);

describe("validateRendererBundleDefinition", () => {
  it("a well-formed bundle has no problems", () => {
    expect(validateRendererBundleDefinition(bundle())).toEqual([]);
  });

  it("refuses what is not a bundle", () => {
    expect(paths(null)).toEqual([""]);
    const d = bundle() as unknown as Record<string, unknown>;
    d.bundleApi = 2;
    (d._meta as Record<string, unknown>).kind = "template";
    expect(paths(d)).toEqual(["_meta.kind", "bundleApi"]);
  });

  it("a cell's kit imports must be kit exports", () => {
    const d = bundle();
    d.cells[1]!.kitImports = ["Board", "Gantt"];
    expect(validateRendererBundleDefinition(d)).toEqual([
      {
        path: "cells[1].kitImports",
        message: "The kit does not export Gantt.",
      },
    ]);
  });

  it("a cell must pass the frame cell check (no network code)", () => {
    const d = bundle();
    d.cells[0]!.code =
      'import x from "https://esm.sh/lodash";\nexport default x;';
    expect(paths(d)).toContain("cells[0].code");
  });

  it("a cell larger than a frame runs is refused; so is a host module over 4 MB", () => {
    const d = bundle();
    d.cells[0]!.code = `export default 1;//${"x".repeat(2 * 1024 * 1024)}`;
    d.hostModules.react = mod("x".repeat(RENDERER_BUNDLE_MAX_MODULE_BYTES + 1));
    expect(paths(d)).toEqual(["hostModules.react", "cells[0].code"]);
  });

  it("required host modules, hashes, unique keys and defaults that name a cell", () => {
    const d = bundle() as unknown as {
      hostModules: Record<string, unknown>;
      cells: Array<Record<string, unknown>>;
      defaults: Record<string, unknown>;
      setSha256: string;
    };
    delete d.hostModules.reactDom;
    d.hostModules.extra = mod("x");
    d.setSha256 = "nope";
    d.cells[1]!.key = "entity-card";
    d.defaults["entity-detail"] = "missing";
    d.defaults.collection = "board";
    expect(paths(d)).toEqual([
      "setSha256",
      "hostModules.reactDom",
      "hostModules.extra",
      "cells[1].key",
      "defaults.entity-detail",
      // The second cell lost its key "board", so the views default names nothing.
      "defaults.views.board",
      "defaults.collection",
    ]);
  });
});
