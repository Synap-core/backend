import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TRIPWIRE — no committed file holds a generated schema hash constant.
 *
 * The api-types schema hash used to be committed in two one-line files
 * (`API_TYPES_SCHEMA_HASH = "<16 hex>"`) that every type-changing PR rewrote,
 * so any two open PRs that touched a tRPC type conflicted, and each merge
 * re-broke the rest. It is now derived from generated.d.ts where it is needed
 * (packages/api/scripts/schema-hash.mjs); this keeps it from coming back.
 *
 * DERIVED: every text file `git ls-files` lists, so a new file joins by
 * existing. generated.d.ts is skipped (1.5 MB, holds no such constant).
 * DOES NOT SEE: a hash under another name than `*SCHEMA_HASH`, or one built
 * by concatenation; untracked files (the build writes dist/, never committed).
 */
const HASH_CONSTANT = /SCHEMA_HASH\s*[=:]\s*["'`][0-9a-f]{8,64}["'`]/i;
const TEXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|md|mdx|ya?ml|sh)$/;

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: __dirname,
  encoding: "utf8",
}).trim();

describe("tripwire: no committed schema hash", () => {
  it("self-check: the pattern sees the retired file's shape", () => {
    const sample = [
      "export const API_TYPES_SCHEMA",
      '_HASH = "133017928c50ae36";',
    ];
    expect(HASH_CONSTANT.test(sample.join(""))).toBe(true);
    expect(HASH_CONSTANT.test("schemaHash: z.string(),")).toBe(false);
  });

  it("no tracked file assigns a schema hash literal", () => {
    const files = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter((f) => TEXT.test(f) && !f.endsWith("/generated.d.ts"));
    // Non-vacuity: the repo tracks thousands of text files, this one among them.
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain(
      "packages/api/src/routers/hub-protocol/rest/health.ts"
    );
    const bad = files.filter((f) =>
      HASH_CONSTANT.test(readFileSync(join(ROOT, f), "utf8"))
    );
    expect(bad).toEqual([]);
  });
});
