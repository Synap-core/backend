/**
 * `GET /installed` — the pure pieces + the projection tripwires.
 *
 * The handler itself is DB-bound; what is asserted here is the part that can
 * silently rot: the cell natural-key parse (which must stay the inverse of the
 * minting function), and the two PROJECTIONS whose omission was the original
 * defect — a field that exists, is written, and is dropped on the way out.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { packageSlugFromCellTypeKey, INSTALLED_KINDS } from "./installed.js";
import { packageCellTypeKey } from "../../../services/cells/install-cell-from-definition.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf8");

describe("packageSlugFromCellTypeKey", () => {
  it("is the exact inverse of packageCellTypeKey (the minting door)", () => {
    // Round-trip against the function that WRITES the key, not against a
    // hand-written literal — a hand-written literal is how a parser and its
    // minter drift.
    for (const [pkg, key] of [
      ["task-views-pack", "kanban"],
      ["a", "b"],
      ["pkg-with-dashes", "cell_with_underscores"],
    ]) {
      expect(packageSlugFromCellTypeKey(packageCellTypeKey(pkg!, key!))).toBe(
        pkg
      );
    }
  });

  it("returns null for a non-package widget key rather than guessing a slug", () => {
    // Generated / first-party widgets must NOT appear as installed packages.
    expect(packageSlugFromCellTypeKey("generated:my-chart")).toBeNull();
    expect(packageSlugFromCellTypeKey("entity-list")).toBeNull();
    expect(packageSlugFromCellTypeKey("cell:onlytwo")).toBeNull();
    expect(packageSlugFromCellTypeKey("cell::key")).toBeNull();
  });

  it("covers every install kind the pod can produce", () => {
    expect([...INSTALLED_KINDS].sort()).toEqual([
      "automation",
      "capability",
      "cell",
      "skill",
      "view",
      "workspace",
    ]);
  });
});

describe("packageSlugFromCellTypeKey — the `unknown` sentinel", () => {
  it('reports null, not a package literally named "unknown"', () => {
    // `marketplace-install.ts` composes the key from
    // `def.packageSlug ?? "unknown"`, so a cell installed without a source
    // package carries that word in the slug position. Returning it verbatim
    // would put `packageSlug: "unknown"` on the row — indistinguishable from a
    // real package of that name, and lookup-able. Absence is not a value.
    expect(packageSlugFromCellTypeKey("cell:unknown:my-card")).toBeNull();
  });

  it("still resolves a genuine slug that merely contains the word", () => {
    expect(packageSlugFromCellTypeKey("cell:unknown-unknowns:x")).toBe(
      "unknown-unknowns"
    );
  });
});

describe("install-health projection tripwires", () => {
  it("Hub GET /workspaces projects the three fields the applier stamps", async () => {
    // `applyPackagePostWorkspace` records a layer-2 failure. This door
    // projected 20 OTHER settings fields and dropped exactly these three —
    // which is the single line where "partially installed" became "installed"
    // for every client. Since W1 the three come from the ONE template state
    // (`templateInstallWire(readTemplateState(settings))`), so the guard is
    // two halves: the door spreads that projection into its row, and the
    // projection carries the three VALUES for a failed space (reachability,
    // not shape). Deleting the spread, or a field from the projection, goes red.
    const src = read("./workspaces.ts");
    expect(
      /\n\s+\.\.\.templateInstallWire\(templateState\),/.test(src),
      "Hub GET /workspaces no longer projects the install health — a partial install is being reported as a clean one."
    ).toBe(true);
    expect(src).toMatch(/const templateState = readTemplateState\(settings\)/);
    const { templateInstallWire } =
      await import("../../../services/template-health.js");
    const { readTemplateState } = await import("@synap/database");
    expect(
      templateInstallWire(
        readTemplateState({
          packageSlug: "crm",
          provisioningStatus: "failed",
          failedStep: "post-workspace",
          failedStepError: "boom",
        })
      )
    ).toEqual({
      provisioningStatus: "failed",
      failedStep: "post-workspace",
      failedStepError: "boom",
    });
  });

  it("GET /installed never defaults an uncomputed drift to false", () => {
    // `drift: false` claims "up to date". Every kind whose drift this door does
    // NOT compute must say `null` (unknown). A `?? false` anywhere here would
    // re-create the exact class of lie this endpoint exists to remove.
    const src = read("./installed.ts");
    expect(/drift:\s*(false|[^,\n]*\?\?\s*false)/.test(src)).toBe(false);
  });
});

describe("cell version stamp — door parity (B3)", () => {
  it("BOTH cell-install doors pass packageVersion", () => {
    // Cells reach the pod through two doors. Stamping the version on one only
    // is the door-parity severance this codebase has shipped five times: the
    // same package, two doors, two different recorded versions.
    const market = read(
      "../../../services/capabilities/marketplace-install.ts"
    );
    const applier = read("../../../services/package-apply-post-workspace.ts");
    for (const [name, src] of [
      ["marketplace-install.ts", market],
      ["package-apply-post-workspace.ts", applier],
    ] as const) {
      const callIdx = src.indexOf("installCellFromDefinition({");
      expect(
        callIdx,
        `${name} no longer calls installCellFromDefinition`
      ).toBeGreaterThan(-1);
      const call = src.slice(callIdx, src.indexOf("});", callIdx));
      expect(
        call.includes("packageVersion:"),
        `${name} installs a cell without stamping packageVersion — that cell can never be reported as behind its package.`
      ).toBe(true);
    }
  });

  it("defineCell keeps version omit-is-silence on the update branches", () => {
    // An UNCONDITIONAL `version:` in an update `.set({...})` would let a door
    // that knows nothing about package versions overwrite a stamped one with
    // the column default — the same erasure `viewTypes` and `contentKind`
    // already guard against.
    const src = read("../../../services/cells/define-cell.ts");
    expect(
      src.includes(
        "input.version === undefined ? {} : { version: input.version }"
      )
    ).toBe(true);
    // Two update branches (workspace-scoped upsert + pod-global manual upsert)
    // and one insert `values` — all three must go through the spread.
    expect(src.split("...versionUpdate").length - 1).toBe(3);
  });
});

describe("overlay health — door parity", () => {
  it("every Hub door that projects template health also projects overlays", () => {
    // DERIVED, not hand-listed: any REST file that calls `templateHealthFor(`
    // is a health door. A new door joins this scan by existing. The MCP verb
    // goes through `listWorkspaceTemplateHealth`, which the overlays pglite
    // test drives directly. Granularity is the file, not the call site.
    const doors = readdirSync(here)
      .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
      .filter((f) => read(`./${f}`).includes("templateHealthFor("));
    // Non-vacuity: /workspaces and /installed today.
    expect(doors).toEqual(
      expect.arrayContaining(["workspaces.ts", "installed.ts"])
    );
    for (const f of doors) {
      const src = read(`./${f}`);
      expect(
        /\n\s+overlays:\s*overlayHealthFor\(/.test(src),
        `${f} projects template health but not \`overlays\` — a retired overlay is invisible through it.`
      ).toBe(true);
      expect(
        src.includes("templateSlugsOf("),
        `${f} resolves the catalog for its spaces' own slugs only — every overlay would read as unknown/unlisted.`
      ).toBe(true);
    }
  });
});
