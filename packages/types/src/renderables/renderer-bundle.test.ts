/**
 * The renderer-bundle definition's pure check (`validateRendererBundleDefinition`).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RENDERER_BUNDLE_KIT_BUDGET_BYTES,
  RENDERER_BUNDLE_MAX_MODULE_BYTES,
  rendererSetDigestText,
  validateRendererBundleDefinition,
  type RendererBundleDefinition,
} from "./index.js";
import {
  POD_BRIDGE_CONTRACT,
  unmetRendererBundleRequirements,
} from "../cell-bridge/bundle-requirements.js";

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

  it("the kit's budget sits between the kit as last measured and the ceiling", () => {
    // 2,864,519 bytes on 22 Nov 2026 (plan cb8470f2): a budget under the
    // measure would refuse today's build; at the ceiling it would budget nothing.
    expect(RENDERER_BUNDLE_KIT_BUDGET_BYTES).toBeGreaterThan(2_864_519);
    expect(RENDERER_BUNDLE_KIT_BUDGET_BYTES).toBeLessThan(
      RENDERER_BUNDLE_MAX_MODULE_BYTES
    );
    // The budget is the official build's, not an install rule: a kit over
    // it but under the ceiling still installs.
    const d = bundle();
    d.hostModules.kit = mod(
      `export const Card = () => null;//${"x".repeat(RENDERER_BUNDLE_KIT_BUDGET_BYTES)}`
    );
    expect(paths(d)).toEqual([]);
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

  it("a default must name a cell that draws its slot", () => {
    const d = bundle();
    d.cells.push({
      key: "detail",
      name: "Detail",
      code: "export default function D() { return null; }",
      sha256: SHA,
      contentKind: "entity-detail",
      kitImports: [],
    });
    // Each default names a real cell, of the wrong slot.
    d.defaults = {
      "entity-card": "detail",
      "entity-detail": "entity-card",
      views: { board: "board", table: "board", gallery: "entity-card" },
    };
    expect(validateRendererBundleDefinition(d)).toEqual([
      {
        path: "defaults.entity-card",
        message: '"detail" does not draw the entity-card slot.',
      },
      {
        path: "defaults.entity-detail",
        message: '"entity-card" does not draw the entity-detail slot.',
      },
      {
        path: "defaults.views.table",
        message: '"board" does not draw the table view.',
      },
      {
        path: "defaults.views.gallery",
        message: '"entity-card" does not draw the gallery view.',
      },
    ]);
  });

  it("a cell that imports the kit needs the kit module", () => {
    const d = bundle();
    delete d.hostModules.kit;
    d.cells[1]!.kitImports = [];
    expect(validateRendererBundleDefinition(d)).toEqual([
      {
        path: "cells[0].kitImports",
        message: "The cell imports the kit, and the bundle has no kit module.",
      },
    ]);
  });
});

describe("requires (plan ad703ccd §3b.5a)", () => {
  it("absent, or a list of op names: valid", () => {
    expect(paths(bundle())).toEqual([]);
    expect(
      paths({ ...bundle(), requires: { bridgeOps: ["entities.get"] } })
    ).toEqual([]);
    // An op this pod does not know is "not yet", never invalid.
    expect(
      paths({ ...bundle(), requires: { bridgeOps: ["pods.teleport"] } })
    ).toEqual([]);
  });

  it("a malformed requires is refused where it is", () => {
    expect(paths({ ...bundle(), requires: ["entities.get"] })).toEqual([
      "requires",
    ]);
    expect(paths({ ...bundle(), requires: { bridgeOps: [1] } })).toEqual([
      "requires.bridgeOps",
    ]);
    expect(
      paths({ ...bundle(), requires: { bridgeContract: 2, bridgeOps: [] } })
    ).toEqual([]);
    expect(paths({ ...bundle(), requires: { bridgeContract: "2" } })).toEqual([
      "requires.bridgeContract",
    ]);
    expect(paths({ ...bundle(), requires: { bridgeContract: 0 } })).toEqual([
      "requires.bridgeContract",
    ]);
    // A requirement this pod does not know is "not yet", never invalid.
    expect(paths({ ...bundle(), requires: { podVersion: "1" } })).toEqual([]);
  });

  it("names what this pod's contract does not meet", () => {
    expect(unmetRendererBundleRequirements(bundle())).toEqual([]);
    expect(
      unmetRendererBundleRequirements({
        ...bundle(),
        requires: { bridgeOps: ["entities.get"] },
      })
    ).toEqual([]);
    const unmet = unmetRendererBundleRequirements({
      ...bundle(),
      bundleApi: 2,
      requires: { bridgeOps: ["entities.get", "pods.teleport"] },
    });
    expect(unmet).toHaveLength(2);
    expect(unmet[0]).toContain("bundle API 2");
    expect(unmet[1]).toContain("pods.teleport");
    expect(unmet[1]).not.toContain("entities.get");
    // The frame contract: at or below this pod's is met, above is held.
    expect(
      unmetRendererBundleRequirements({
        ...bundle(),
        requires: { bridgeContract: POD_BRIDGE_CONTRACT },
      })
    ).toEqual([]);
    expect(
      unmetRendererBundleRequirements({
        ...bundle(),
        requires: { bridgeContract: POD_BRIDGE_CONTRACT + 1 },
      })
    ).toEqual([
      `It is built for frame contract ${POD_BRIDGE_CONTRACT + 1}; this pod answers contract ${POD_BRIDGE_CONTRACT}.`,
    ]);
    // A requirement a newer contract added holds the bundle on this pod.
    expect(
      unmetRendererBundleRequirements({
        ...bundle(),
        requires: { contractVersion: 3 },
      })
    ).toEqual(["It needs contractVersion, which this pod does not know yet."]);
  });
});

describe("rendererSetDigestText (what setSha256 hashes)", () => {
  it("one line per module, sorted by name: a fixed vector", () => {
    const h = (c: string) => c.repeat(64);
    const text = rendererSetDigestText({
      tokensCss: h("6"),
      reactDomClient: h("5"),
      react: h("3"),
      kit: h("2"),
      reactDom: h("4"),
      jsxRuntime: h("1"),
    });
    expect(text).toBe(
      `jsxRuntime ${h("1")}\n` +
        `kit ${h("2")}\n` +
        `react ${h("3")}\n` +
        `reactDom ${h("4")}\n` +
        `reactDomClient ${h("5")}\n` +
        `tokensCss ${h("6")}\n`
    );
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(
      "7d6b29b997caf12b40c34dd273169797afbe782e5dc150757ad28ff5611e39c9"
    );
  });
});
