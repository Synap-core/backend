/**
 * TRIPWIRE — every door that writes a surface or a cell type judges the
 * calling KEY (security review H3, 27 Nov 2026): a key bound to one space
 * makes, attaches, takes off surfaces, and defines, installs, retires cell
 * types, in that space only.
 *
 * The services (`services/surfaces/attach.ts`, `create.ts`, the cell
 * lifecycle) floor the PERSON; the key's binding is the door's to pass. So a
 * file that calls a write service must also call the key check:
 *   - surfaces: `surfaceKeyRefusal` (`services/surfaces/key-binding.ts`);
 *   - cell types: `confineCellScope` (or `resolveConfinedWorkspace` on a
 *     tRPC workspace procedure).
 * Pinned per FILE with both counts: a new write call, or a new caller file,
 * fails until someone decides how it judges the key.
 *
 * Runtime proof is elsewhere: `services/surfaces/key-binding.pglite.test.ts`
 * and `routers/hub-protocol/rest/cells.key-confinement.pglite.test.ts`.
 *
 * WHAT IT CANNOT SEE: whether the check guards the write it sits beside (the
 * pglite tests do); a write reached through a variable alias.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const API_SRC = fileURLToPath(new URL("..", import.meta.url));

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (
      name.endsWith(".ts") &&
      !name.includes(".test.") &&
      !full.includes("__tripwires__") &&
      !full.includes("__tests__")
    )
      yield full;
  }
}

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const count = (s: string, re: RegExp) => [...s.matchAll(re)].length;

const SURFACE_WRITE = /\b(?:createSurface|attachSurface|detachSurface)\(/g;
const SURFACE_CHECK = /\bsurfaceKeyRefusal\(/g;
const CELL_WRITE = /\b(?:defineCell|installMarketplaceCell|retireCellType)\(/g;
const CELL_CHECK = /\b(?:confineCellScope|resolveConfinedWorkspace)\(/g;

/** The services themselves (they floor the person) and who acts with no key. */
const SURFACE_SERVICES = new Set([
  "services/surfaces/attach.ts",
  "services/surfaces/create.ts",
]);
const CELL_NO_KEY: Record<string, string> = {
  "services/cells/define-cell.ts": "the one cell writer itself",
  "services/cells/marketplace-cell-lifecycle.ts":
    "the install / retire services; their doors check the key",
  "services/cells/install-cell-from-definition.ts":
    "installs a package's cell for its installer; reached only from install doors",
  "routers/proposals/executors/cell.ts":
    "an APPROVAL: the approver acts, no key (the filing door checked the key)",
  "utils/rule-loop-callers.ts": "the pod's own rule loop: no key",
};

/** file → [write calls, key checks]. */
const SURFACE_DOORS: Record<string, [number, number]> = {
  "routers/surfaces.ts": [3, 3],
  "routers/hub-protocol/rest/surfaces.ts": [3, 3],
  "routers/mcp/handlers/entity.ts": [1, 1],
  // synap_attach_surface: one check guards its attach-or-detach branch.
  "routers/mcp/handlers/build.ts": [6, 5],
};
const CELL_DOORS: Record<string, [number, number]> = {
  "routers/hub-protocol/rest/cells.ts": [3, 3],
  "routers/hub-protocol/widget-definitions.ts": [1, 1],
  // upsert writes; deactivate retires with its own update (no service call).
  "routers/widget-definitions.ts": [1, 2],
  "routers/mcp/handlers/build.ts": [1, 1],
};

function scan() {
  const surfaces: Record<string, [number, number]> = {};
  const cells: Record<string, [number, number]> = {};
  let files = 0;
  for (const file of walk(API_SRC)) {
    files += 1;
    const rel = relative(API_SRC, file).split("\\").join("/");
    const code = strip(readFileSync(file, "utf8"));
    const sw = count(code, SURFACE_WRITE);
    if (sw > 0 && !SURFACE_SERVICES.has(rel)) {
      surfaces[rel] = [sw, count(code, SURFACE_CHECK)];
    }
    const cw = count(code, CELL_WRITE);
    if (cw > 0 && !(rel in CELL_NO_KEY)) {
      cells[rel] = [cw, count(code, CELL_CHECK)];
    }
  }
  return { files, surfaces, cells };
}

describe("surface and cell writes judge the calling key", () => {
  it("non-vacuity: the scan sees many files and every pinned door", () => {
    const { files, surfaces, cells } = scan();
    expect(files).toBeGreaterThan(500);
    expect(Object.keys(surfaces).sort()).toEqual(
      Object.keys(SURFACE_DOORS).sort()
    );
    expect(Object.keys(cells).sort()).toEqual(Object.keys(CELL_DOORS).sort());
  });

  it("each surface write door checks the key, counts pinned", () => {
    expect(scan().surfaces).toEqual(SURFACE_DOORS);
  });

  it("each cell write door confines the key, counts pinned", () => {
    expect(scan().cells).toEqual(CELL_DOORS);
  });
});
