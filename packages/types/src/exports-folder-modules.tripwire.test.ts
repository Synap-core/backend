/**
 * A new `@synap-core/types` module is a folder `src/<name>/index.ts` and needs
 * NO edit to `package.json`.
 *
 * WHY. `package.json` `exports` was a hand-kept list of 90+ sub-paths, and
 * every PR that added a module edited the same file: PRs #287, #288 and #311
 * each conflicted with main on it. The `"./*"` pattern in `exports` maps
 * `@synap-core/types/<name>` to `dist/<name>/index.{js,d.ts}`, the shape every
 * folder module has. Exact keys keep precedence over the pattern (Node and
 * TypeScript both), so the older explicit entries stay valid.
 *
 * WHAT IT PROVES. The set of folder modules is DERIVED from
 * `src/<folder>/index.ts` (never listed here). Each one must resolve, by Node's
 * `exports` rules (exact key first, else the longest-prefix pattern), to
 * exactly `./dist/<name>/index.js` (import) and `./dist/<name>/index.d.ts`
 * (types). Revert the pattern and the folders that never had an explicit
 * entry fail; point an explicit entry at a wrong file and that folder fails.
 * When `dist/` is built, the resolved files must also exist.
 *
 * WHAT IT DOES NOT SEE. Whether a given bundler honours pattern exports: Vite
 * and Metro consumers derive their aliases from the EXACT keys (see the PR
 * that added this test). Only Node/TypeScript resolution is proven here.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

type Target = string | Record<string, unknown> | null | undefined;

/** Node's PACKAGE_EXPORTS_RESOLVE for a "./<sub>" request, one `*` per key. */
export function resolveExport(
  exportsMap: Record<string, Target>,
  request: string
): { target: Target; match: string } | undefined {
  if (Object.prototype.hasOwnProperty.call(exportsMap, request)) {
    return { target: exportsMap[request], match: "exact" };
  }
  let best: { key: string; star: string } | undefined;
  for (const key of Object.keys(exportsMap)) {
    const at = key.indexOf("*");
    if (at === -1) continue;
    const prefix = key.slice(0, at);
    const suffix = key.slice(at + 1);
    if (
      request.length >= key.length &&
      request.startsWith(prefix) &&
      request.endsWith(suffix)
    ) {
      // Longest prefix wins, as in PATTERN_KEY_COMPARE.
      if (!best || prefix.length > best.key.indexOf("*")) {
        best = {
          key,
          star: request.slice(prefix.length, request.length - suffix.length),
        };
      }
    }
  }
  if (!best) return undefined;
  const substitute = (v: Target): Target =>
    typeof v === "string"
      ? v.replaceAll("*", best!.star)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v).map(([k, x]) => [k, substitute(x as Target)])
          )
        : v;
  return { target: substitute(exportsMap[best.key]), match: best.key };
}

function folderModules(): string[] {
  return readdirSync(join(PKG, "src"), { withFileTypes: true })
    .filter(
      (d) => d.isDirectory() && existsSync(join(PKG, "src", d.name, "index.ts"))
    )
    .map((d) => d.name)
    .sort();
}

const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as {
  exports: Record<string, Target>;
};

describe("@synap-core/types: a folder module needs no package.json edit", () => {
  it("the resolver follows Node's rules (self-check)", () => {
    const map: Record<string, Target> = {
      "./*": { import: "./dist/*/index.js" },
      "./a/b": { import: "./dist/a/b.js" },
    };
    expect(resolveExport(map, "./a/b")?.match).toBe("exact");
    expect(resolveExport(map, "./a")?.target).toEqual({
      import: "./dist/a/index.js",
    });
    expect(resolveExport({ "./x": "./x.js" }, "./y")).toBeUndefined();
  });

  it("every src/<name>/index.ts resolves to dist/<name>/index.{js,d.ts}", () => {
    const folders = folderModules();
    // Non-vacuity: the scan found the real package.
    expect(folders.length).toBeGreaterThan(50);
    expect(folders).toContain("focus-sessions");

    const wrong = folders.flatMap((name) => {
      const hit = resolveExport(pkg.exports, `./${name}`);
      const t = (hit?.target ?? {}) as { import?: string; types?: string };
      const want = {
        import: `./dist/${name}/index.js`,
        types: `./dist/${name}/index.d.ts`,
      };
      return t.import === want.import && t.types === want.types
        ? []
        : [`${name}: ${hit ? JSON.stringify(t) : "does not resolve"}`];
    });
    expect(wrong).toEqual([]);
  });

  it("when dist/ is built, every resolved target exists", () => {
    if (!existsSync(join(PKG, "dist", "index.js"))) return; // unbuilt: Release gate builds it
    const missing = folderModules().flatMap((name) => {
      const t = resolveExport(pkg.exports, `./${name}`)?.target as
        { import?: string; types?: string } | undefined;
      return [t?.import, t?.types]
        .filter((f): f is string => !!f)
        .filter((f) => !existsSync(join(PKG, f)))
        .map((f) => `${name} -> ${f}`);
    });
    expect(missing).toEqual([]);
  });
});
