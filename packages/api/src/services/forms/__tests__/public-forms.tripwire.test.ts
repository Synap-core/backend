/**
 * TRIPWIRE — the public door's own code never reaches for a caller-chosen
 * identity, never writes anything but a create, and never borrows the shared
 * capture agent (Sites W4).
 *
 * DERIVED, never hand-listed: the scanned set is (a) every Hub REST file that
 * registers a `/public/…` route, plus (b) the relative-import closure of those
 * files RESTRICTED to the public doors' own service homes (`services/forms/`,
 * `services/sharing/`). A new public route or a new helper module joins the
 * scan by existing.
 *
 * WHAT IT DOES NOT COVER (measured 2026-09-26): the UNRESTRICTED closure of a
 * public route file is ~560 files, because `rest/_shared.ts` (logger, status
 * mapper) pulls the whole hub router world, ~21 of which legitimately use
 * `createHubProtocolCallerContext` for authenticated doors. Those are shared
 * infrastructure, not the public door; the guard's boundary is the two service
 * homes above plus the route files. A public door that imported a hub router
 * and CALLED one of its procedures would pass this file — the behavioural
 * guard for that is the PGlite suite (`guest-forms.pglite.test.ts`), which
 * asserts every gate call is the form actor's `entity.create`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../../..");
const HUB_REST = path.join(SRC, "routers/hub-protocol/rest");
const SERVICE_HOMES = [
  path.join(SRC, "services/forms") + path.sep,
  path.join(SRC, "services/sharing") + path.sep,
];

const ROUTE_RE =
  /app\.(get|post|put|patch|delete)\(\s*["'`](\/public\/[^"'`]*)["'`]/g;
const IMPORT_RE =
  /(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

const isTest = (f: string) =>
  /\.test\.tsx?$/.test(f) || f.includes("__tests__");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Source without block comments and without whole-line `//` / `*` comments. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

function resolveImport(from: string, rel: string): string | null {
  const base = path.resolve(path.dirname(from), rel).replace(/\.js$/, "");
  for (const cand of [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

function publicRouteFiles(): string[] {
  return walk(HUB_REST)
    .filter((f) => !isTest(f))
    .filter((f) => [...readFileSync(f, "utf8").matchAll(ROUTE_RE)].length > 0);
}

/** Route files + their import closure inside the public doors' service homes. */
function scannedSet(): string[] {
  const roots = publicRouteFiles();
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of readFileSync(f, "utf8").matchAll(IMPORT_RE)) {
      const target = resolveImport(f, (m[1] ?? m[2])!);
      if (!target || isTest(target)) continue;
      if (SERVICE_HOMES.some((home) => target.startsWith(home)))
        stack.push(target);
    }
  }
  return [...seen];
}

/** Does this source import or call the hub caller-context factory? */
function usesHubCallerContext(src: string): boolean {
  const code = codeOnly(src);
  return (
    /\bcreateHubProtocolCallerContext\b/.test(code) ||
    /from\s+["'][^"']*hub-protocol\/utils(?:\.js)?["']/.test(code) ||
    /from\s+["']\.\.\/utils(?:\.js)?["']/.test(code)
  );
}

describe("public doors never build a hub caller context", () => {
  it("self-check: the detector sees a real importer and ignores a comment", () => {
    expect(
      usesHubCallerContext(
        readFileSync(path.join(HUB_REST, "tools.ts"), "utf8")
      )
    ).toBe(true);
    expect(
      usesHubCallerContext(
        `// createHubProtocolCallerContext is forbidden here\nconst a = 1;`
      )
    ).toBe(false);
    expect(
      usesHubCallerContext(
        `import { createHubProtocolCallerContext as c } from "./_shared.js";`
      )
    ).toBe(true);
  });

  it("DERIVED: no public route file, and no module it reaches in services/forms|sharing, uses it", () => {
    const routes = publicRouteFiles().map((f) => path.basename(f));
    // Non-vacuity: the share read, the guest form and the legacy projection.
    expect(routes).toEqual(
      expect.arrayContaining([
        "public-shares.ts",
        "public-forms.ts",
        "public-projection.ts",
      ])
    );
    const scanned = scannedSet();
    const rel = scanned.map((f) => path.relative(SRC, f));
    expect(rel).toEqual(
      expect.arrayContaining([
        "services/forms/guest-submit.ts",
        "services/forms/form-definition.ts",
        "services/sharing/public-read.ts",
      ])
    );
    const offenders = scanned.filter((f) =>
      usesHubCallerContext(readFileSync(f, "utf8"))
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});

describe("the guest write path is create-only and never the capture agent", () => {
  const FILES = ["guest-submit.ts", "direct-materialize.ts"].map((f) =>
    path.join(SRC, "services/forms", f)
  );

  it("every gate door literal in the guest path is entity/create; no update/delete/facet door", () => {
    for (const f of FILES) {
      const code = codeOnly(readFileSync(f, "utf8"));
      expect(code, f).not.toMatch(
        /action:\s*["'](?:update|delete|archive|merge|purge)["']/
      );
      expect(code, f).not.toMatch(
        /\.(?:update|delete|attachFacet|detachFacet|merge)\(\s*\{/
      );
      expect(code, f).not.toMatch(
        /\.delete\(\s*(?:entities|relations|proposals)/
      );
      expect(code, f).not.toMatch(
        /\.update\(\s*(?:entities|relations|users)\b/
      );
    }
    const door = codeOnly(readFileSync(FILES[0]!, "utf8"));
    // Non-vacuity: the one governed call is there, and it is a create.
    expect(door).toMatch(/subjectType:\s*"entity",\s*action:\s*"create"/);
    expect([...door.matchAll(/subjectType:/g)].length).toBe(1);
  });

  it("services/forms never resolves the shared capture agent", () => {
    const files = walk(path.join(SRC, "services/forms")).filter(
      (f) => !isTest(f)
    );
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const code = codeOnly(readFileSync(f, "utf8"));
      expect(code, f).not.toMatch(
        /getCaptureAgentUserId|ensure-capture-agent|submitCaptureGraph/
      );
    }
  });
});
