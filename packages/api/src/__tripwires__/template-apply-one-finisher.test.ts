/**
 * ONE finisher earns a template apply's version stamp; ONE module writes the
 * template state.
 *
 * The version stamp says "this space is at template version X" — layer 1 AND
 * layer 2. Every door that wrote it itself wrote it after layer 1, before
 * layer 2 ran, so a layer 2 that failed or only proposed left a stamp claiming
 * a convergence that never happened (founder pod 2026-10-12: CRM read
 * "current" while its playbook waited on a proposal). Then the state was
 * spread over eight settings keys written by ~15 writers, four of them
 * read-modify-write (APPLY-ONE-DOOR-PLAN §2). Now the state is ONE object,
 * `settings.template`, written only by `writeTemplateState`
 * (@synap/database `utils/template-state.ts`), which also writes the legacy
 * mirror (`packageVersion`, `provisioningStatus`, `failedStep*`,
 * `completedSteps`, `templateApply`, `installedPacks`) until W6.
 *
 * Pinned here, by source scan:
 *  (1) every file that calls the create/resume core is a DOOR and calls
 *      `finishTemplateApply(` — the set is DERIVED by grep, so a new door joins
 *      the scan by existing. Since W2 the ONE apply (`template-apply/index.ts`)
 *      is that door for every wrapper over it: a file calling `applyTemplate(`
 *      is finished by the module, and must not also call the core itself;
 *  (2) a version STAMP reaches `writeTemplateState(` only from the finisher
 *      module — its apply door and its boot channel (`finishBootConvergence`,
 *      held while the last apply is unfinished, re-checked under the writer's
 *      lock). Since W4 the reconcile util binds the identity only;
 *  (3) no file outside the module writes `template` or a mirrored key into
 *      settings (`mergeSettings(` / `.set(` / `.create(` / `.update(` spans that
 *      touch settings, `settings.<key> =`, `const|let *settings* = {…}`
 *      literals, and SQL `jsonb_set`/`jsonb_build_object` on the key) — over
 *      EVERY `packages/<pkg>/src` and `apps/<app>/src` of the backend,
 *      derived by listing the directories; the guarded key list is parsed
 *      out of the module's own `TEMPLATE_STATE_MIRROR_KEYS`;
 *  (4) an overlay pack's VERSION is recorded only by the finisher (on
 *      convergence, and its boot channel for the boot ledger pass); compose
 *      records the PACK without a version — every `upsertPack(` / `withPack(`
 *      caller outside the module is derived and classified.
 *
 * NOT covered, measured: granularity is the FILE, not the call site (a door
 * file with two core calls and one finisher call stays green). (3) reads
 * object literals passed DIRECTLY to those calls and `*settings*` literals; a
 * patch assembled any other way (e.g. `patch.provisioningStatus = v` on a
 * differently named object, or a computed key) is not seen. A `.set(`/
 * `.create(` span is only judged when it mentions `settings` — that is what
 * keeps unrelated tables' `template:` columns (rule seeds) out, and it means a
 * column-only write (`provisioningStatus: x` with no settings) is not seen
 * except where it sits next to a settings write. Classified writers are
 * listed with their reason below.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(here, "..");
const APPS_API_SRC = join(here, "../../../../apps/api/src");
const DB_SRC = join(here, "../../../database/src");
const BACKEND = join(here, "../../../..");
const MODULE = join(DB_SRC, "utils/template-state.ts");

/** Every backend source root, DERIVED: packages/<pkg>/src + apps/<app>/src. */
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

/** Source with comments blanked, so prose naming a call is never a call. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

const CORE_CALL =
  /(?<!function\s)\b(createWorkspaceFromDefinition|createWorkspaceFromDefinitionIdempotent|materializeWorkspaceCore|applyLayerOne)\s*\(/;
/** The plumbing that DEFINES / wraps the core — it hands the version back, never finishes. */
const PLUMBING = new Set([
  "services/workspace-creation-service.ts",
  "services/workspace-materialization-service.ts",
  // Layer one of `applyTemplate` (W2): resolveTarget → plan → build/re-sync.
  "services/template-apply/layer-one.ts",
]);
const FINISHER = "services/template-apply-finisher.ts";

/** Every `name(`…`)` argument span, paren-balanced (strings are not parsed). */
function callSpans(src: string, name: RegExp): string[] {
  const spans: string[] = [];
  const re = new RegExp(name.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    spans.push(src.slice(start, i - 1));
  }
  return spans;
}

/** The guarded keys, parsed out of the module's own mirror list (+ `template`). */
function guardedKeys(): string[] {
  const src = readFileSync(MODULE, "utf8");
  const block = src.match(
    /TEMPLATE_STATE_MIRROR_KEYS = \[([\s\S]*?)\] as const/
  )?.[1];
  const keys = [...(block ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]!);
  return ["template", ...keys];
}

/** Every `const|let <name containing "settings"> … = {`…`}` literal, brace-balanced. */
function settingsLiterals(src: string): string[] {
  const spans: string[] = [];
  const re = /\b(?:const|let)\s+\w*[sS]ettings\w*\b[^=;]*=\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    spans.push(src.slice(start, i - 1));
  }
  return spans;
}

/**
 * The arguments of the MODULE's own calls blanked: a key passed to
 * `templateStateSettings(` / `writeTemplateState(` IS the one writer.
 */
function withoutModuleCalls(src: string): string {
  let out = src;
  const re =
    /\b(templateStateSettings|writeTemplateState|upsertPack|removePack)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out))) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    while (i < out.length && depth > 0) {
      const ch = out[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    out =
      out.slice(0, start) +
      out.slice(start, i - 1).replace(/[^\n]/g, " ") +
      out.slice(i - 1);
  }
  return out;
}

/** The settings writes in a source that carry one of `keys`. */
function stateWrites(raw: string, keys: string[]): string[] {
  const src = withoutModuleCalls(raw);
  const alt = keys.join("|");
  const KEY = new RegExp(`(?<![\\w.])(${alt})\\s*:(?!:)`);
  const hits: string[] = [];
  const spans = [
    ...callSpans(src, /\bmergeSettings\s*\(/),
    ...[
      ...callSpans(src, /\.set\s*\(/),
      ...callSpans(src, /\.create\s*\(/),
      ...callSpans(src, /\.update\s*\(/),
    ].filter((span) => /\bsettings\b/.test(span)),
    ...settingsLiterals(src),
  ];
  for (const span of spans) {
    const m = span.match(KEY);
    if (m) hits.push(`${m[1]}: ${span.trim().slice(0, 100)}`);
  }
  for (const m of src.matchAll(
    new RegExp(`settings\\??\\.(${alt})\\s*=(?!=)`, "g")
  ))
    hits.push(m[0]);
  for (const m of src.matchAll(
    new RegExp(
      `(jsonb_set\\([^)]*'\\{(${alt})\\}'|jsonb_build_object\\(\\s*'(${alt})')`,
      "g"
    )
  ))
    hits.push(m[0]);
  return hits;
}

const rel = (p: string) => relative(API_SRC, p);
const apiFiles = walk(API_SRC);

describe("template apply — one finisher writes the stamp and active", () => {
  it("(1) every door that calls the create/resume core calls finishTemplateApply", () => {
    const doors = apiFiles.filter(
      (p) => !PLUMBING.has(rel(p)) && CORE_CALL.test(code(p))
    );
    // Non-vacuity: the derived set is the door list (2026-10-14: the ONE
    // apply and the dependency resolver — Hub packages, the approve executor,
    // marketplace-install, (W3) the tRPC definition-engine /
    // installFromCatalog and (W4) Hub workspaces + MCP create now wrap
    // `applyTemplate`, below; invites' seedPlugin was retired in 6a2427283).
    expect(doors.length).toBeGreaterThanOrEqual(2);
    expect(doors.map(rel)).toEqual(
      expect.arrayContaining([
        "services/template-apply/index.ts",
        "services/package-dependency-resolver.ts",
      ])
    );
    // A door finishes by calling the finisher, or the module's catalog
    // layer-2 step, which finishes (pinned just below).
    const missing = doors
      .filter(
        (p) =>
          !/\b(finishTemplateApply|applyCatalogLayerTwo)\s*\(/.test(code(p))
      )
      .map(rel);
    expect(missing).toEqual([]);
  });

  it("(1a) the module's catalog layer-2 step reaches the finisher", () => {
    const src = code(join(API_SRC, "services/template-apply/index.ts"));
    /** A top-level function's text: from its declaration to the next one. */
    const fnBody = (decl: string): string => {
      const at = src.indexOf(decl);
      expect(at, `${decl} not found`).toBeGreaterThanOrEqual(0);
      const rest = src.slice(at + decl.length);
      const next = rest.search(/\n(export )?(async )?function /);
      return next > 0 ? rest.slice(0, next) : rest;
    };
    expect(fnBody("export async function applyCatalogLayerTwo(")).toMatch(
      /\bfinishWithTruth\s*\(/
    );
    expect(fnBody("async function finishWithTruth(")).toMatch(
      /\bfinishTemplateApply\s*\(/
    );
  });

  it("(1b) a wrapper over applyTemplate never also drives the core itself", () => {
    const APPLY_CALL = /(?<!function\s)\bapplyTemplate\s*\(/;
    const wrappers = apiFiles
      .filter((p) => rel(p) !== "services/template-apply/index.ts")
      .filter((p) => APPLY_CALL.test(code(p)));
    // Non-vacuity: the W2 wrappers (D1/D2, D3/D4, D14), the W3 tRPC one
    // (D7, D8/D9, D16, D17) and the W4 ones (D10 + D11, D12).
    expect(wrappers.map(rel)).toEqual(
      expect.arrayContaining([
        "routers/hub-protocol/rest/packages.ts",
        "routers/proposals/executors/workspace.ts",
        "services/capabilities/marketplace-install.ts",
        "routers/workspaces/template-door.ts",
        "routers/hub-protocol/rest/workspaces.ts",
        "routers/mcp/handlers/workspace.ts",
      ])
    );
    // A wrapper that also called the core would run a second, unfinished
    // apply beside the module's (the pre-W2 spread this guards against).
    const both = wrappers.filter((p) => CORE_CALL.test(code(p))).map(rel);
    expect(both).toEqual([]);
  });

  it("(2) a version stamp reaches writeTemplateState only from the finisher (apply + boot channel)", () => {
    const files = [...apiFiles, ...walk(APPS_API_SRC), ...walk(DB_SRC)];
    const stampers = files
      .filter((p) => p !== MODULE)
      .filter((p) =>
        callSpans(code(p), /(?<!function\s)\bwriteTemplateState\s*\(/).some(
          (span) => /(?<![\w.])version\s*:/.test(span)
        )
      )
      .map(rel)
      .sort();
    // The finisher alone: its apply door (on convergence) and its boot
    // channel (what the boot pass checked; held while the last apply is
    // unfinished). W4 took the boot pass's channel out of the reconcile util.
    expect(stampers).toEqual([FINISHER]);
  });

  it("(3) only the template-state module writes settings.template or a mirrored key", () => {
    const keys = guardedKeys();
    // Non-vacuity: the parsed list is the mirror (7 keys) + template.
    expect(keys).toEqual(
      expect.arrayContaining([
        "template",
        "packageVersion",
        "provisioningStatus",
        "failedStep",
        "failedStepError",
        "completedSteps",
        "templateApply",
        "installedPacks",
      ])
    );
    const roots = sourceRoots();
    expect(roots.length).toBeGreaterThanOrEqual(10);
    const files = roots.flatMap(walk);
    expect(files.length).toBeGreaterThan(1000);
    // Classified, not hidden:
    //  - the repository's generic doors PROMOTE `provisioningStatus` into its
    //    column from whatever blob they are handed (create seeds come from
    //    `templateStateSettings`, the settings save carries the key over);
    //  - pod-to-pod replica sync writes the peer's row wholesale by design.
    const CLASSIFIED = new Set(
      [
        join(DB_SRC, "repositories/workspace-repository.ts"),
        join(API_SRC, "routers/sync.ts"),
      ].map(rel)
    );
    const offenders = files
      .filter((p) => p !== MODULE && !CLASSIFIED.has(rel(p)))
      .flatMap((p) => stateWrites(code(p), keys).map((h) => `${rel(p)}: ${h}`));
    expect(offenders).toEqual([]);
  });

  it("self-check: the scanner sees a literal sample of what it hunts", () => {
    const keys = guardedKeys();
    const hits = (src: string) => stateWrites(src, keys);
    expect(
      hits(`await repo.mergeSettings(id, { provisioningStatus: "failed" }, u);`)
    ).toHaveLength(1);
    expect(
      hits(
        `await db.update(w).set({ settings: { ...s, packageVersion } }).where(x);`
      )
    ).toHaveLength(0); // shorthand is not a `key:` — see the next sample
    expect(
      hits(
        `await db.update(w).set({ settings: { ...s, packageVersion: v } }).where(x);`
      )
    ).toHaveLength(1);
    expect(hits(`if (v) settings.installedPacks = next;`)).toHaveLength(1);
    expect(
      hits(
        `const settingsPatch: Partial<WorkspaceSettings> = { packageSlug: t, templateApply: null };`
      )
    ).toHaveLength(1);
    expect(
      hits(
        "settings: sql`jsonb_set(settings, '{completedSteps}', ${x}::jsonb)`"
      )
    ).toHaveLength(1);
    expect(
      hits(
        `await repo.create({ name, ownerId, settings: { template: t } }, u);`
      )
    ).toHaveLength(1);
    // The module's own seed/writer calls are the one writer, not offenders.
    expect(
      hits(
        `await repo.create({ settings: { ...s, ...templateStateSettings({ state: "building", completedSteps: [] }) } }, u);`
      )
    ).toHaveLength(0);
    // Not settings: a rule seed's `template:` column is not this state.
    expect(
      hits(`await db.update(rules).set({ template: t, key: k });`)
    ).toHaveLength(0);
    expect(hits(`await repo.mergeSettings(id, { layout }, u);`)).toHaveLength(
      0
    );
    expect(CORE_CALL.test("const r = await materializeWorkspaceCore({")).toBe(
      true
    );
    expect(
      CORE_CALL.test("export async function createWorkspaceFromDefinition(")
    ).toBe(false);
  });

  it("(4) only the finisher (its boot channel for the ledger pass) records an overlay's version", () => {
    const files = [...apiFiles, ...walk(APPS_API_SRC), ...walk(DB_SRC)].filter(
      (p) => p !== MODULE
    );
    const PACK_CALL = /(?<!function\s)\b(upsertPack|withPack)\s*\(/;
    const callers = files.filter((p) => PACK_CALL.test(code(p))).map(rel);
    // Non-vacuity: compose and the finisher call it (W4: the boot ledger pass
    // records through the finisher's boot channel).
    expect(callers.sort()).toEqual(
      ["services/compose-overlay.ts", FINISHER].sort()
    );
    // Compose records the pack WITHOUT a version (layer 2 has not run yet).
    const composeSpans = callSpans(
      code(join(API_SRC, "services/compose-overlay.ts")),
      PACK_CALL
    );
    expect(composeSpans.length).toBeGreaterThan(0);
    for (const span of composeSpans) expect(span).not.toMatch(/\bversion\b/);
  });
});
