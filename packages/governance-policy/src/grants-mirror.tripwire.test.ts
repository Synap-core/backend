/**
 * The grant grammar has ONE home: `@synap-core/types/grants`
 * (`packages/types/src/grants/grammar.ts`). This package keeps a byte-identical
 * mirror (`./grants.ts`) because it cannot depend on @synap-core/types without
 * a build cycle (types →dev @synap/database → governance-policy → types).
 *
 * A mirror is only safe under a tripwire: any drift — one changed character in
 * either copy — fails here. The behaviour itself is tested once, beside the
 * home (`types/src/grants/grammar.test.ts`).
 *
 * What this does NOT cover: it proves the two files are the same, never that
 * the grammar is right (a convergence guard proves sameness, not correctness).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const HOME = "../../types/src/grants/grammar.ts";
const MIRROR = "./grants.ts";

describe("grant grammar mirror", () => {
  it("still sees the grammar in both copies (non-vacuity)", () => {
    for (const rel of [HOME, MIRROR]) {
      const text = read(rel);
      expect(text).toContain("export function permits(");
      expect(text).toContain("export function parsePermission(");
      expect(text.length).toBeGreaterThan(4000);
    }
  });

  it("is byte-identical to its home in @synap-core/types", () => {
    expect(read(MIRROR)).toBe(read(HOME));
  });
});
