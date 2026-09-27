import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isPackDefinition } from "./pack-definition.js";
import { SUITE_TAG } from "./compose-suite-package-definition.js";

/**
 * The pack signal is ONE constant. `pack-definition.ts` once declared its own
 * `PACK_TAG = "suite"` beside `SUITE_TAG` — two tables that agree only until
 * one is edited (RV1 S3).
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.includes(".test.")) out.push(p);
  }
  return out;
}

describe("pack signal: one constant", () => {
  it("isPackDefinition reads SUITE_TAG", () => {
    expect(isPackDefinition({ _meta: { tags: [SUITE_TAG] } })).toBe(true);
    expect(isPackDefinition({ tags: [SUITE_TAG] })).toBe(true);
    expect(isPackDefinition({ _meta: { tags: ["workspace"] } })).toBe(false);
  });

  it("the tag literal is declared exactly once in api/src", () => {
    const root = join(__dirname, "..");
    const files = walk(root);
    expect(files.length).toBeGreaterThan(500); // non-vacuity
    const decls = files.filter((f) =>
      /(?:const|let)\s+\w+\s*(?::[^=]+)?=\s*["']suite["']/.test(
        readFileSync(f, "utf8")
      )
    );
    expect(decls.map((f) => f.slice(root.length + 1))).toEqual([
      "services/compose-suite-package-definition.ts",
    ]);
  });
});
