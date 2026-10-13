/**
 * A secret read from the environment is compared in constant time — through
 * `safeTokenEqual` (`@synap/auth`, the one helper), never `===` / `!==`.
 * Security wave 2026-10-13 (LOW: non-constant-time compares; H4: the
 * PROVISIONING_TOKEN compares).
 *
 * The scanned set is DERIVED: every non-test .ts file under
 * synap-backend/{packages,apps}/*\/src, and in each file every
 * `const X = process.env.<NAME>` whose NAME ends a secret word (TOKEN, SECRET,
 * KEY, PASSWORD). A comparison `X ===|!== <identifier>` (either side) or
 * `=== process.env.<SECRET>` is a hit. Comparisons against a literal,
 * `undefined` or `null` (flags, presence checks) are not.
 *
 * What it does NOT see (measured by construction, not by test): a secret
 * reached through a config object (`config.x.secret`), a `let`, or a value
 * passed to another function before the compare. Granularity is the line.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Known sites still to fix, held by another lane of the same wave. Each entry
 * must STILL be a hit (a fixed site must leave this list), so the list only
 * shrinks.
 */
const PENDING: Record<string, string> = {
  "packages/api/src/routers/workspaces/invites.ts":
    "owned by SEC-P1 (invites.ts) this wave",
};

const SECRET_ENV = /^\w*(TOKEN|SECRET|KEY|PASSWORD)$/;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (
        /\.tsx?$/.test(name) &&
        !/\.(test|spec)\.tsx?$/.test(name) &&
        !name.endsWith(".d.ts")
      )
        out.push(full);
    }
  };
  for (const top of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(REPO, top))) {
      const src = join(REPO, top, pkg, "src");
      try {
        if (statSync(src).isDirectory()) walk(src);
      } catch {
        // package without src/
      }
    }
  }
  return out;
}

/** Secret-env variable names declared in `src`, and the offending lines. */
export function scan(src: string): { vars: string[]; hits: string[] } {
  const vars = new Set<string>();
  for (const m of src.matchAll(
    /\bconst\s+(\w+)\s*=\s*process\.env\.(\w+)\b/g
  )) {
    if (SECRET_ENV.test(m[2]!)) vars.add(m[1]!);
  }
  const hits: string[] = [];
  const NOT_A_SECRET = /^(undefined|null|true|false)$/;
  src.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    for (const m of code.matchAll(/([\w.$?]+)\s*[!=]==?\s*([\w.$?]+|["'`])/g)) {
      const [left, right] = [m[1]!, m[2]!];
      const isSecret = (side: string) =>
        vars.has(side) ||
        (/^process\.env\.(\w+)$/.test(side) &&
          SECRET_ENV.test(side.slice("process.env.".length)));
      const other = (side: string) =>
        /^["'`]$/.test(side) ? null : NOT_A_SECRET.test(side) ? null : side;
      if (
        (isSecret(left) && other(right)) ||
        (isSecret(right) && other(left))
      ) {
        hits.push(`${i + 1}: ${line.trim()}`);
      }
    }
  });
  return { vars: [...vars], hits };
}

describe("env secrets are compared in constant time", () => {
  const files = sourceFiles();
  const results = files.map((file) => ({
    file: relative(REPO, file),
    ...scan(readFileSync(file, "utf8")),
  }));

  it("is non-vacuous: the walk and the declaration scan see real code", () => {
    expect(files.length).toBeGreaterThan(500);
    const declared = results.reduce((n, r) => n + r.vars.length, 0);
    expect(declared).toBeGreaterThan(20);
    // the scanner still recognises the shapes it hunts
    expect(
      scan("const t = process.env.FOO_TOKEN;\nif (a !== t) {}").hits
    ).toHaveLength(1);
    expect(scan("if (b === process.env.BAR_SECRET) {}").hits).toHaveLength(1);
    expect(
      scan('const t = process.env.FOO_TOKEN;\nif (t === "") {}').hits
    ).toHaveLength(0);
    expect(
      scan("const t = process.env.FOO_TOKEN;\nif (!safeTokenEqual(a, t)) {}")
        .hits
    ).toHaveLength(0);
  });

  it("no source file compares an env secret with === / !==", () => {
    const offenders = results
      .filter((r) => r.hits.length > 0 && !(r.file in PENDING))
      .map((r) => `${r.file}\n  ${r.hits.join("\n  ")}`);
    expect(offenders).toEqual([]);
  });

  it("every PENDING site is still a hit (a fixed site leaves the list)", () => {
    for (const file of Object.keys(PENDING)) {
      const r = results.find((x) => x.file === file);
      expect(r, `${file} not scanned`).toBeDefined();
      expect(
        r!.hits.length,
        `${file} is fixed — remove it from PENDING`
      ).toBeGreaterThan(0);
    }
  });
});
