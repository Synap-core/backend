import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TRIPWIRE — a proposal executor hands a helper the TYPED db handle
 * (`await getDb()`), never the module-level `db` proxy cast `as never`.
 * `executors/link.ts` did (RV1 S14): the cast silenced exactly the check that
 * says whether the helper's queries run on the handle it declares.
 *
 * DERIVED: every non-test `.ts` in `routers/proposals/executors/`.
 * DOES NOT SEE: other casts (`as any`, `as unknown as Db`) — only the
 * `db|database as never` shape that was the defect.
 */
const DIR = join(__dirname, "../routers/proposals/executors");

describe("tripwire: executors pass a typed db", () => {
  it("self-check", () => {
    expect(/\b(db|database) as never\b/.test("f(db as never, {")).toBe(true);
  });

  it("no executor casts its db handle `as never`", () => {
    const files = readdirSync(DIR).filter(
      (f) => f.endsWith(".ts") && !f.includes(".test.")
    );
    expect(files.length).toBeGreaterThan(8); // non-vacuity
    expect(files).toContain("link.ts");
    const bad = files.filter((f) =>
      /\b(db|database) as never\b/.test(readFileSync(join(DIR, f), "utf8"))
    );
    expect(bad).toEqual([]);
  });
});
