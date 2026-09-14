/**
 * TRIPWIRE — every profile writer stamps `origin` (0263).
 *
 * Two layers, and this file is the second:
 *  1. COMPILE-TIME: `CreateProfileInput.origin` is REQUIRED, so a typed
 *     `ProfileRepository.create({...})` without it fails `tsc`.
 *  2. THIS SCAN, for what the type system cannot see: `as any`/`as never`
 *     casts at a create call, drizzle `.insert(profiles)` bypassing the
 *     repository, and raw-SQL `INSERT INTO profiles`.
 *
 * The writer set is DERIVED, never hand-listed: every non-test `.ts` under
 * `packages/{database,api,jobs}/src` is scanned, a repository variable is found
 * by `= new ProfileRepository(` (including the `new (await import(...))
 * .ProfileRepository(` form), and each of its `.create({` object literals must
 * name `origin:`. A new writer joins the scan by existing.
 *
 * WHAT IT CANNOT SEE (read off the regexes):
 *  - a repository reached without a local `= new ProfileRepository(` binding
 *    (a class field `this.profileRepo = ...` IS matched; a repo passed in as a
 *    parameter under another name is not — layer 1 still covers it if typed);
 *  - a create literal built elsewhere and passed as a variable (`create(input)`);
 *  - table names built at runtime, `sql.unsafe`, `.sql` migrations, tests.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PACKAGES = join(process.cwd(), "..");
const ROOTS = ["database/src", "api/src", "jobs/src"].map((r) =>
  join(PACKAGES, r)
);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (
      p.endsWith(".ts") &&
      !p.endsWith(".test.ts") &&
      !p.endsWith(".d.ts")
    )
      out.push(p);
  }
  return out;
}

/** The balanced `{...}` starting at `open` (an index of `{`). */
function balancedObject(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

interface Site {
  file: string;
  kind: "repo.create" | "drizzle.insert" | "raw.insert";
  body: string;
}

const REPO_BINDING =
  /([A-Za-z_$][\w$.]*)\s*=\s*new\s+(?:\(\s*await\s+import\([^)]*\)\s*\)\s*\.)?ProfileRepository\s*\(/g;

export function findProfileWriteSites(file: string, src: string): Site[] {
  const sites: Site[] = [];
  const vars = new Set(
    [...src.matchAll(REPO_BINDING)].map((m) => m[1].replace(/^this\./, ""))
  );
  for (const v of vars) {
    const call = new RegExp(
      `\\b${v.replace(/\$/g, "\\$")}\\s*\\.create\\(\\s*\\{`,
      "g"
    );
    for (const m of src.matchAll(call)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      sites.push({
        file,
        kind: "repo.create",
        body: balancedObject(src, open),
      });
    }
  }
  for (const m of src.matchAll(
    /\.insert\(\s*profiles\s*\)\s*\.values\(\s*\{/g
  )) {
    const open = (m.index ?? 0) + m[0].length - 1;
    sites.push({
      file,
      kind: "drizzle.insert",
      body: balancedObject(src, open),
    });
  }
  for (const m of src.matchAll(
    /INSERT\s+INTO\s+"?profiles"?\s*\(([^)]*)\)/gi
  )) {
    sites.push({ file, kind: "raw.insert", body: m[1] });
  }
  return sites;
}

/** Drops block and line comments, so prose can neither satisfy nor hide a stamp. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// `origin: x` or shorthand `origin,` / `origin }`, read after comments are stripped.
const stamps = (s: Site) =>
  s.kind === "raw.insert"
    ? /\borigin\b/.test(s.body)
    : /[{,]\s*origin\s*[:,}]/.test(stripComments(s.body));

const all: Site[] = ROOTS.flatMap((root) =>
  walk(root).flatMap((f) =>
    findProfileWriteSites(relative(PACKAGES, f), readFileSync(f, "utf8"))
  )
);

describe("tripwire — every profile writer stamps origin", () => {
  it("self-check: the scanner sees each writer shape in a literal sample", () => {
    const sample = `
      const profileRepo = new ProfileRepository(db);
      await profileRepo.create({ slug: "x", uiHints: { icon: "a" } });
      const r2 = new (await import("@synap/database")).ProfileRepository(d);
      await r2.create({ slug: "y", origin: "authored" });
      await r2.create({
        slug: "z",
        // a comment between the comma and the stamp must not hide it
        origin: "template",
      });
      await r2.create({
        slug: "w", // was: slug, origin: "core" — prose, not a stamp
      });
      await db.insert(profiles).values({ id, slug }).returning();
      await tx\`INSERT INTO profiles (slug, display_name) VALUES (1, 2)\`;
    `;
    const found = findProfileWriteSites("sample.ts", sample);
    expect(found.map((s) => s.kind).sort()).toEqual([
      "drizzle.insert",
      "raw.insert",
      "repo.create",
      "repo.create",
      "repo.create",
      "repo.create",
    ]);
    // Exactly y and z stamp. Each discriminating row rules out one wrong rule:
    //  - x: nested braces in uiHints must not end the literal early;
    //  - z: a scan that does NOT strip comments misses a real stamp;
    //  - w: a scan that does NOT strip comments counts prose as a stamp.
    const stamped = found
      .filter((s) => s.kind === "repo.create" && stamps(s))
      .map((s) => /slug:\s*"(\w)"/.exec(s.body)?.[1]);
    expect(stamped).toEqual(["y", "z"]);
  });

  it("non-vacuity: the scan finds a plausible writer set across all three packages", () => {
    const byKind = (k: Site["kind"]) => all.filter((s) => s.kind === k);
    expect(byKind("repo.create").length).toBeGreaterThanOrEqual(8);
    expect(byKind("drizzle.insert").length).toBeGreaterThanOrEqual(2);
    expect(byKind("raw.insert").length).toBeGreaterThanOrEqual(1);
    const pkgs = new Set(all.map((s) => s.file.split("/")[0]));
    expect([...pkgs].sort()).toEqual(["api", "database", "jobs"]);
  });

  it("every writer names origin", () => {
    const missing = all
      .filter((s) => !stamps(s))
      .map((s) => `${s.file} [${s.kind}]`);
    expect(missing).toEqual([]);
  });
});
