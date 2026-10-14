/**
 * ONE finisher writes a template apply's outcome markers.
 *
 * The version stamp (`settings.packageVersion`) says "this space is at template
 * version X" — layer 1 AND layer 2. Every door that wrote it itself wrote it
 * after layer 1, before layer 2 ran, so a layer 2 that failed or only proposed
 * left a stamp claiming a convergence that never happened (founder pod
 * 2026-10-12: CRM read "current" while its playbook waited on a proposal).
 * The create/resume core now hands the version back (`pendingVersionStamp`)
 * and leaves the space "pending"; only `finishTemplateApply` stamps it and
 * marks the space "active", and only when layer 2 converged.
 *
 * Pinned here, by source scan:
 *  (1) every file that calls the create/resume core is a DOOR and calls
 *      `finishTemplateApply(` — the set is DERIVED by grep, so a new door joins
 *      the scan by existing (and a door that forgets the finisher leaves its
 *      spaces "pending" forever, which this catches first);
 *  (2) only the finisher calls `stampWorkspacePackageVersion(`;
 *  (3) no other file writes a `packageVersion` key through `mergeSettings(` /
 *      `.set(` / a `settings.packageVersion =` assignment;
 *  (4) the overlay ledger's version (`installedPacks[].version`) is recorded
 *      only by the finisher (on convergence) and the boot ledger pass (after
 *      its own `playbookReportConverged`); compose records the PACK, never its
 *      version — every `upsertInstalledPack(` caller is derived and classified.
 *
 * NOT covered, measured: granularity is the FILE, not the call site — a door
 * file with two core calls and one finisher call stays green if the second
 * call forgets it (verified: removing one of the two resume-branch finisher
 * calls in definition-engine.ts stays green). (3) reads object literals passed
 * DIRECTLY to those calls plus any `const|let <…settings…> = {…}` literal (the
 * shape both adopt doors used for their patch); a patch assembled any other
 * way (e.g. `patch.packageVersion = v` on a differently named object) is not
 * seen.
 * `reconcileWorkspaceFromDefinition({ packageVersion })` (@synap/database) is a
 * second channel: its one caller that passes a version is the boot reconcile,
 * which gates the version on its own convergence report (playbooks + rules),
 * and the util itself holds it while the space's last apply is unfinished
 * (`templateApplyUnfinished`, pinned in @synap/database
 * `create-workspace-hands-back-stamp.pglite.test.ts`) — classified below.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(here, "..");
const APPS_API_SRC = join(here, "../../../../apps/api/src");
const DB_SRC = join(here, "../../../database/src");

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
  /(?<!function\s)\b(createWorkspaceFromDefinition|createWorkspaceFromDefinitionIdempotent|materializeWorkspaceCore)\s*\(/;
/** The plumbing that DEFINES / wraps the core — it hands the version back, never finishes. */
const PLUMBING = new Set([
  "services/workspace-creation-service.ts",
  "services/workspace-materialization-service.ts",
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

const PACKAGE_VERSION_KEY = /\bpackageVersion\s*[:,}]/;

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

/** The settings writes in a source that carry a `packageVersion` key. */
function packageVersionWrites(src: string): string[] {
  const hits: string[] = [];
  for (const span of [
    ...callSpans(src, /\bmergeSettings\s*\(/),
    ...callSpans(src, /\.set\s*\(/),
    ...settingsLiterals(src),
  ]) {
    if (PACKAGE_VERSION_KEY.test(span)) hits.push(span.trim().slice(0, 120));
  }
  for (const m of src.matchAll(/settings\.packageVersion\s*=(?!=)/g))
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
    // Non-vacuity: the derived set is the door list (2026-10-12: Hub
    // packages, Hub workspaces, MCP, invites, tRPC definition-engine, approve
    // executor, marketplace-install, dependency-resolver).
    expect(doors.length).toBeGreaterThanOrEqual(8);
    expect(doors.map(rel)).toEqual(
      expect.arrayContaining([
        "routers/hub-protocol/rest/packages.ts",
        "routers/proposals/executors/workspace.ts",
        "services/package-dependency-resolver.ts",
      ])
    );
    const missing = doors
      .filter((p) => !/\bfinishTemplateApply\s*\(/.test(code(p)))
      .map(rel);
    expect(missing).toEqual([]);
  });

  it("(2) only the finisher calls stampWorkspacePackageVersion", () => {
    const callers = apiFiles
      .filter((p) =>
        /(?<!function\s)\bstampWorkspacePackageVersion\s*\(/.test(code(p))
      )
      .map(rel);
    expect(callers).toEqual([FINISHER]);
  });

  it("(3) no other file writes packageVersion into settings", () => {
    // Classified, not hidden:
    //  - the stamp writer itself (called only by the finisher — test 2);
    //  - the database `reconcileWorkspaceFromDefinition`, which writes the
    //    version a caller passes — its one version-passing caller is the boot
    //    reconcile, gated on its own convergence report (playbooks + rules) —
    //    and holds it while the last apply is unfinished.
    const CLASSIFIED = new Set([
      "services/workspace-creation-service.ts",
      relative(
        API_SRC,
        join(DB_SRC, "utils/reconcile-workspace-from-definition.ts")
      ),
    ]);
    const files = [...apiFiles, ...walk(APPS_API_SRC), ...walk(DB_SRC)];
    expect(files.length).toBeGreaterThan(200);
    const offenders = files
      .filter((p) => !CLASSIFIED.has(rel(p)))
      .flatMap((p) =>
        packageVersionWrites(code(p)).map((h) => `${rel(p)}: ${h}`)
      );
    expect(offenders).toEqual([]);
  });

  it("self-check: the scanner sees a literal sample of what it hunts", () => {
    expect(
      packageVersionWrites(
        `await repo.mergeSettings(id, { packageSlug: s, packageVersion: v }, u);`
      )
    ).toHaveLength(1);
    expect(
      packageVersionWrites(
        `await db.update(w).set({ settings: { ...s, packageVersion } }).where(x);`
      )
    ).toHaveLength(1);
    expect(
      packageVersionWrites(
        `if (packageVersion) settings.packageVersion = packageVersion;`
      )
    ).toHaveLength(1);
    expect(
      packageVersionWrites(
        `const settingsPatch: Partial<WorkspaceSettings> = { packageSlug: t, ...(v ? { packageVersion: v } : {}) };`
      )
    ).toHaveLength(1);
    expect(
      packageVersionWrites(
        `await repo.mergeSettings(id, { packageSlug: s }, u);`
      )
    ).toHaveLength(0);
    expect(CORE_CALL.test("const r = await materializeWorkspaceCore({")).toBe(
      true
    );
    expect(
      CORE_CALL.test("export async function createWorkspaceFromDefinition(")
    ).toBe(false);
  });

  it("(4) only the finisher and the boot ledger pass record an overlay's version", () => {
    const callers = apiFiles.filter((p) =>
      /(?<!function\s)\bupsertInstalledPack\s*\(/.test(code(p))
    );
    // Non-vacuity: compose, the finisher and the boot ledger pass all call it.
    expect(callers.map(rel).sort()).toEqual([
      "services/compose-overlay.ts",
      "services/reconcile-installed-packs.ts",
      FINISHER,
    ]);
    // Compose records the pack WITHOUT a version (layer 2 has not run yet).
    const composeSpans = callSpans(
      code(join(API_SRC, "services/compose-overlay.ts")),
      /(?<!function\s)\bupsertInstalledPack\s*\(/
    );
    expect(composeSpans.length).toBeGreaterThan(0);
    for (const span of composeSpans) expect(span).not.toMatch(/\bversion\b/);
  });
});
