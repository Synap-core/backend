/**
 * TRIPWIRE — one whole-string UUID check: `isUuid` (`./structured-value.ts`).
 *
 * Backend source held ~50 hand copies of
 * `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`, each its
 * own `UUID_RE` / `UUID_SHAPE` / `isUuid`. They now read the helper. This scan
 * fails when a new copy of that exact literal appears in non-test source
 * outside the allow-list below.
 *
 * What it does NOT see (measured, not implied): a copy spelled differently
 * (`[0-9A-F]`, `\d`, no `i` flag, a `new RegExp("…")` string, a version-pinned
 * `[1-5]` variant) — those are different rules, not copies. Test files are not
 * scanned. Granularity is the copy: an allow-listed file is held to its count.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const COPY =
  "/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i";

/**
 * Files that keep their own copy, and why (one word each, in the PR):
 * the helper itself; `vocabulary` (structured-value imports it: a cycle);
 * `deferred-writes` (the guard's false branch would narrow a `string` to
 * `never`); `playbooks` (no `@synap-core/types` dependency); zod `.regex`
 * schemas; a harness's data `idPattern`; an e2e `toMatch` assertion.
 */
const ALLOWED: Record<string, number> = {
  "packages/types/src/property-render/structured-value.ts": 1,
  "packages/types/src/vocabulary/index.ts": 1,
  "packages/types/src/proposals/deferred-writes.ts": 1,
  "packages/types/src/events/dev-loop.ts": 1,
  "packages/types/src/agents/harnesses.ts": 1,
  "packages/playbooks/src/params.ts": 1,
  "packages/api/src/routers/hub-protocol/rest/_codecs/_openapi.ts": 1,
  "packages/test-e2e/src/utils/assertions.ts": 1,
};

const ROOT = join(import.meta.dirname, "../../../..");
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".git",
  "coverage",
  "docs",
  "__tests__",
  "__tripwires__",
]);
const CODE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else if (CODE.test(name) && !TEST.test(name)) out.push(path);
  }
}

function countCopies(src: string): number {
  return src.split(COPY).length - 1;
}

describe("one UUID check", () => {
  it("can still see a copy (self-check)", () => {
    expect(countCopies(`const X =\n  ${COPY};`)).toBe(1);
  });

  it("no new hand copy of the anchored UUID regex in backend source", () => {
    const files: string[] = [];
    for (const top of ["apps", "packages", "scripts"]) {
      walk(join(ROOT, top), files);
    }
    // Non-vacuity: the walk reached the backend tree, not an empty folder.
    expect(files.length).toBeGreaterThan(1000);

    const found: Record<string, number> = {};
    for (const file of files) {
      const n = countCopies(readFileSync(file, "utf8"));
      if (n > 0) found[relative(ROOT, file).split("\\").join("/")] = n;
    }
    // The helper's own copy is seen: the scan reads what it hunts.
    expect(
      found["packages/types/src/property-render/structured-value.ts"]
    ).toBe(1);
    const unexpected = Object.entries(found).filter(
      ([file, n]) => n !== (ALLOWED[file] ?? 0)
    );
    expect(
      unexpected,
      "A hand-copied UUID check: import { isUuid } from " +
        '"@synap-core/types/property-render" instead'
    ).toEqual([]);
    // An allow entry nothing uses would silently widen the guard.
    expect(Object.keys(found).sort()).toEqual(Object.keys(ALLOWED).sort());
  });
});
