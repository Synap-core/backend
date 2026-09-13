/**
 * TRIPWIRE — apps/api's `OPEN_VIEW_VALUES` equals `OBJECT_NAV_VIEWS`.
 *
 * `@synap-core/types/navigation` is the one `view` allowlist (pod api, browser,
 * relay). `apps/api/src/open-dispatch.ts` keeps a copy only because `apps/api`
 * does not depend on `@synap-core/types`. This guard reads that file as TEXT
 * (so it runs without importing the Hono app) and asserts the copy is the same
 * list, so a view added on one side cannot silently be dropped by the deep-link
 * bounce on the other.
 *
 * SAMENESS, not correctness: it proves the two lists agree, never that either
 * is right. It parses a single-line `["a", "b"] as const` literal; a copy
 * rewritten into another shape (spread, multi-line, a computed value) fails the
 * parse assertion loudly rather than passing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { OBJECT_NAV_VIEWS } from "@synap-core/types/navigation";

const APPS_API_SRC = fileURLToPath(
  new URL("../../../../apps/api/src/", import.meta.url)
);

const DECL =
  /export const OPEN_VIEW_VALUES\s*=\s*\[([^\]\n]*)\]\s*as const\s*;/;

function parseOpenViewValues(source: string): string[] | null {
  const m = DECL.exec(source);
  if (!m) return null;
  return [...m[1]!.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]!);
}

/** Derived, not hand-pathed: every open-dispatch.ts under apps/api/src. */
function findOpenDispatchFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findOpenDispatchFiles(p));
    else if (entry.name === "open-dispatch.ts") out.push(p);
  }
  return out;
}

describe("tripwire: apps/api OPEN_VIEW_VALUES is the same list as OBJECT_NAV_VIEWS", () => {
  it("the parser can still see a literal sample of what it hunts", () => {
    expect(
      parseOpenViewValues(
        `export const OPEN_VIEW_VALUES = ["room", 'graph'] as const;`
      )
    ).toEqual(["room", "graph"]);
    expect(
      parseOpenViewValues(`export const OTHER = ["room"] as const;`)
    ).toBeNull();
  });

  it("apps/api's copy deep-equals the shared allowlist", () => {
    const files = findOpenDispatchFiles(APPS_API_SRC);
    // Non-vacuity: exactly the one copy exists and is found.
    expect(files).toHaveLength(1);
    const values = parseOpenViewValues(readFileSync(files[0]!, "utf8"));
    expect(
      values,
      "OPEN_VIEW_VALUES declaration not found / reshaped"
    ).not.toBeNull();
    expect(values!.length).toBeGreaterThanOrEqual(1);
    expect(values).toEqual([...OBJECT_NAV_VIEWS]);
  });
});
