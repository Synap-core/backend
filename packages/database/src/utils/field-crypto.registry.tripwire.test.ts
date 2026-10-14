/**
 * TRIPWIRE — every field-crypto call site in the pod names a cell that is in
 * `ENCRYPTED_COLUMNS`, every registered cell has a call site, and nothing but
 * the pod door imports `@synap-core/field-crypto`.
 *
 * The audit and the re-encrypt sweeper only see registered cells: a value
 * encrypted into an unregistered cell could never be rotated, and the old key
 * could never be removed. `FieldRef.column` is already typed from the
 * registry; this scan additionally refuses a column passed through a variable
 * (which the type cannot pin to one literal) and a stale registry entry.
 *
 * The scanned set is DERIVED: every non-test `.ts` file under
 * `packages/<pkg>/src` and `apps/<app>/src` of this repo that calls one of the
 * door functions below. The door files themselves (they take the column from
 * their caller or the registry) are the only exemptions.
 *
 * Does NOT cover: a call through an alias (`const enc = encryptField`) — none
 * exist; the alias would also lose the typed ref, so the type catches it. A
 * helper that wraps a door call with a literal column (e.g. `sealFor`) is
 * covered at the wrapped call, not at the helper's callers.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ENCRYPTED_COLUMNS, encryptedColumnName } from "./encrypted-columns.js";

const REPO = path.resolve(__dirname, "../../../..");
const DOOR_FNS = [
  "encryptField",
  "decryptField",
  "resolveField",
  "rebindField",
  "encryptServiceKey",
  "decryptServiceKey",
  "resolveServiceKey",
  "encryptServerSide",
  "decryptServerSide",
  "encryptConfig",
  "decryptConfig",
];
const CALL_RE = new RegExp(`\\b(${DOOR_FNS.join("|")})\\(`, "g");
/** The doors themselves, and the sweeper (it takes the column from the registry). */
const DOOR_FILES = new Set([
  "packages/database/src/utils/field-crypto.ts",
  "packages/database/src/utils/service-key-crypto.ts",
  "packages/database/src/utils/server-vault.ts",
  "packages/database/src/utils/field-crypto-sweep.ts",
]);
/** The one pod file allowed to import the package. */
const PACKAGE_IMPORT_ALLOWED = new Set([
  "packages/database/src/utils/field-crypto.ts",
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist") return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") && !full.endsWith(".d.ts") ? [full] : [];
  });
}

/** The text between the call's `(` and its matching `)`. */
export function callArgs(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }
  throw new Error("unbalanced call");
}

interface CallSite {
  file: string;
  line: number;
  fn: string;
  columns: string[];
}

function callSites(file: string, source: string): CallSite[] {
  const sites: CallSite[] = [];
  for (const m of source.matchAll(CALL_RE)) {
    const before = source.slice(Math.max(0, m.index! - 9), m.index!);
    if (/function\s+$/.test(before)) continue; // a declaration, not a call
    // Inside a comment line (a doc mention, not a call). Line-level on
    // purpose: stripping comments from the whole file once hid real code.
    const lineStart = source.lastIndexOf("\n", m.index!) + 1;
    const lead = source.slice(lineStart, m.index!);
    if (/^\s*(\*|\/\/|\/\*)/.test(lead) || lead.includes("//")) continue;
    const args = callArgs(source, m.index! + m[0].length - 1);
    sites.push({
      file,
      line: source.slice(0, m.index!).split("\n").length,
      fn: m[1]!,
      columns: [...args.matchAll(/\bcolumn:\s*"([^"]+)"/g)].map((c) => c[1]!),
    });
  }
  return sites;
}

const SOURCE_ROOTS = ["packages", "apps"].flatMap((top) =>
  readdirSync(path.join(REPO, top))
    .filter((pkg) => pkg !== "field-crypto") // the package itself
    .map((pkg) => path.join(REPO, top, pkg, "src"))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    })
);

const FILES = SOURCE_ROOTS.flatMap(walk)
  .map((full) => path.relative(REPO, full).split(path.sep).join("/"))
  .filter((rel) => !rel.endsWith(".test.ts") && !rel.includes("/__tests__/"));

const SITES = FILES.filter((rel) => !DOOR_FILES.has(rel)).flatMap((rel) =>
  callSites(rel, readFileSync(path.join(REPO, rel), "utf8"))
);
const REGISTERED = new Set(ENCRYPTED_COLUMNS.map(encryptedColumnName));

describe("pod field-crypto call sites ⊆ ENCRYPTED_COLUMNS", () => {
  it("the extractor still sees a literal sample (self-check)", () => {
    const sample = `x = resolveServiceKey(svc.apiKey, {\n  column: "intelligence_services.api_key",\n  rowId: f(svc.id),\n});`;
    expect(callSites("sample.ts", sample)).toEqual([
      {
        file: "sample.ts",
        line: 1,
        fn: "resolveServiceKey",
        columns: ["intelligence_services.api_key"],
      },
    ]);
    expect(
      callSites("s.ts", "export function encryptServerSide(a: string) {}")
    ).toEqual([]);
    expect(
      callSites(
        "s.ts",
        "  // stored by encryptField().\n   * see decryptConfig(x)"
      )
    ).toEqual([]);
    // A call with no literal column is SEEN (and then refused below).
    expect(callSites("s.ts", "encryptServerSide(v)")[0]!.columns).toEqual([]);
  });

  it("is not vacuous", () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(SITES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(SITES.map((s) => s.file)).size).toBeGreaterThanOrEqual(15);
  });

  it("every call names exactly one registered column, as a literal", () => {
    const bad = SITES.filter(
      (s) => s.columns.length !== 1 || !REGISTERED.has(s.columns[0] as never)
    ).map((s) => `${s.file}:${s.line} ${s.fn} → [${s.columns.join(", ")}]`);
    expect(bad).toEqual([]);
  });

  it("every registered column has at least one call site (no stale entry)", () => {
    const used = new Set(SITES.flatMap((s) => s.columns));
    expect([...REGISTERED].filter((c) => !used.has(c))).toEqual([]);
  });

  it("nothing but the pod door imports @synap-core/field-crypto", () => {
    const offenders = FILES.filter(
      (rel) =>
        !PACKAGE_IMPORT_ALLOWED.has(rel) &&
        /from\s+["']@synap-core\/field-crypto["']/.test(
          readFileSync(path.join(REPO, rel), "utf8")
        )
    );
    expect(offenders).toEqual([]);
  });
});
