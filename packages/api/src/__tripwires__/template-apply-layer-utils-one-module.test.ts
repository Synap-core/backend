/**
 * ONE module drives the template layers: only `services/template-apply/`
 * (and the files that DEFINE a layer util) call them. Every other caller is
 * classified below, with its reason.
 *
 * The layer utils: the create/resume core (`createWorkspaceFromDefinition`),
 * the re-sync (`reconcileWorkspaceFromDefinition`), dependencies + compose
 * (`materializeWorkspaceCore`, `composeOntoBaseWorkspace`), layer one
 * (`applyLayerOne`), layer 2 (`applyPackagePostWorkspace`) and the finisher
 * (`finishTemplateApply`). A new door built on any of them — a procedure that
 * re-syncs a space and runs layer 2 itself — skips the plan, the record and
 * the honest stamp (review M7; old D16 was exactly that: no finisher, no
 * record). Such a door must go through `applyTemplate` instead, or be added
 * to CLASSIFIED with the reason it may not.
 *
 * DERIVED, never hand-listed: every backend source root (packages/<pkg>/src,
 * apps/<app>/src) is walked; a definer is any file that declares one of the
 * utils (`export function` / `export async function`); a new caller joins the
 * scan by existing.
 *
 * NOT covered, measured: granularity is the FILE (a classified file may add a
 * second call for another purpose and stay green, and a DEFINER's own calls
 * are exempt — compose-overlay re-syncs, the materialization service drives
 * compose); an aliased import
 * (`import { reconcileWorkspaceFromDefinition as r }`) or a call through a
 * variable is not seen; comments are stripped so prose never counts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(here, "../../../..");

const UTILS = [
  "createWorkspaceFromDefinition",
  "reconcileWorkspaceFromDefinition",
  "materializeWorkspaceCore",
  "composeOntoBaseWorkspace",
  "applyLayerOne",
  "applyPackagePostWorkspace",
  "finishTemplateApply",
] as const;

/** A CALL of a util: not its declaration, not a method definition. */
const CALL = new RegExp(
  `(?<!function\\s)(?<!async\\s)(?<![.\\w])(${UTILS.join("|")})\\s*\\(`,
  "g"
);
const DEFINES = new RegExp(
  `export\\s+(?:async\\s+)?function\\s+(${UTILS.join("|")})\\s*[(<]`
);

/** The one module. */
const MODULE_DIR = "packages/api/src/services/template-apply/";

/** Callers outside the module, each with WHY it is not a door through it. */
const CLASSIFIED: Record<string, string> = {
  "apps/api/src/startup/reconcile-workspaces-to-templates.ts":
    "D19 boot pass: re-converges every space's layer 1 every boot (applyTemplate is stamp-gated); stamps only through finishBootConvergence, under its coverage rule",
  "packages/api/src/services/reconcile-installed-packs.ts":
    "D20 boot pass for overlay packs: layer 1 + playbooks, records versions through finishBootConvergence",
  "packages/api/src/routers/workspaces/definition-engine.ts":
    "D16 dryRun: a preview READ (reconcile with dryRun: true) behind `if (input.dryRun)` — writes nothing",
  "packages/api/src/services/package-dependency-resolver.ts":
    "dependency resolution: composes overlay/pack dependencies onto their base; layer 2 + finish go through the module's applyCatalogLayerTwo",
  "packages/api/src/services/workspace-materialization-service.ts":
    "materializeWorkspaceCore (a definer) drives the resolver and compose for applyTemplate (deferCreate); its non-deferred create branch is a W6 leftover",
};

function sourceRoots(): string[] {
  const roots: string[] = [];
  for (const group of ["packages", "apps"]) {
    for (const name of readdirSync(join(BACKEND, group))) {
      const src = join(BACKEND, group, name, "src");
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch {
        // no src/ — not a source package
      }
    }
  }
  return roots;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (
      name.endsWith(".ts") &&
      !name.endsWith(".d.ts") &&
      !/\.test\.ts$/.test(name) &&
      !p.includes("__tests__") &&
      !p.includes("__tripwires__")
    )
      out.push(p);
  }
  return out;
}

/** Source with comments blanked, so prose naming a util is never a call. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

const rel = (p: string) => relative(BACKEND, p);
const files = sourceRoots().flatMap(walk);
const callers = files
  .map((p) => ({ file: rel(p), src: code(p) }))
  .filter((f) => new RegExp(CALL.source).test(f.src));

describe("only the template-apply module drives the template layers", () => {
  it("the scan can still see a call, and not a declaration (self-check)", () => {
    const hit = (s: string) => new RegExp(CALL.source).test(s);
    expect(hit("const r = await reconcileWorkspaceFromDefinition({")).toBe(
      true
    );
    expect(hit("await applyPackagePostWorkspace(input)")).toBe(true);
    expect(hit("export async function applyPackagePostWorkspace(")).toBe(false);
    expect(hit("  async createWorkspaceFromDefinition(input) {")).toBe(false);
    expect(hit("client.createWorkspaceFromDefinition(x)")).toBe(false);
  });

  it("every caller is the module, a definer, or classified with its reason", () => {
    // Non-vacuity: the scan walks the backend and sees the module's own calls.
    expect(files.length).toBeGreaterThan(500);
    expect(callers.map((c) => c.file)).toEqual(
      expect.arrayContaining([
        `${MODULE_DIR}index.ts`,
        `${MODULE_DIR}layer-one.ts`,
      ])
    );
    const stray = callers
      .filter((c) => !c.file.startsWith(MODULE_DIR))
      .filter((c) => !DEFINES.test(c.src))
      .filter((c) => !(c.file in CLASSIFIED))
      .map((c) => c.file);
    expect(
      stray,
      "these files call a template layer util directly — go through applyTemplate (services/template-apply), or classify them here with the reason"
    ).toEqual([]);
  });

  it("every classified caller still calls one (the map never outlives its reason)", () => {
    const calling = new Set(callers.map((c) => c.file));
    const stale = Object.keys(CLASSIFIED).filter((f) => !calling.has(f));
    expect(stale, "remove these from CLASSIFIED").toEqual([]);
  });
});
