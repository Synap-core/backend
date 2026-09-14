import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const REST_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "agent-skills.ts"
);
const ROUTER_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skills.ts"
);
const SEARCH_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "services",
  "skills",
  "search.ts"
);

/**
 * The agent-skill REST catalog is an external read surface, not a management
 * API. These guards prevent a future convenient query from bypassing the same
 * visibility, active-lifecycle, and approval gates as the canonical resolver.
 */
describe("tripwire: external agent-skill reads keep canonical visibility gates", () => {
  const rest = readFileSync(REST_FILE, "utf8");
  const router = readFileSync(ROUTER_FILE, "utf8");

  // The LIST door's gates moved into `services/skills/search.ts` (the one
  // search function, lane X1 2026-09-14), so the list half is asserted there
  // and the route must delegate to it. Behaviour is pinned by
  // `services/skills/__tests__/search.pglite.test.ts`; this scan only keeps a
  // future edit from quietly dropping a gate token.
  const search = readFileSync(SEARCH_FILE, "utf8");
  const listRoute = rest.slice(
    rest.indexOf('app.get("/agent-skills", '),
    rest.indexOf('app.get("/agent-skills/by-slug/:slug"')
  );

  it("shares the three-tier visibility predicate with the canonical skills router", () => {
    expect(router).toContain("visibleSkillsWhere(userId, input?.workspaceId)");
    // Both slug/id load conditions.
    expect(
      rest.match(/visibleSkillsWhere\(c\.get\("userId"\)/g)?.length
    ).toBeGreaterThanOrEqual(2);
    expect(search).toMatch(/visibleSkillsWhere\(input\.userId/);
    expect(listRoute.length).toBeGreaterThan(0);
    expect(listRoute).toMatch(/searchInstructionSkills\(\{/);
    expect(listRoute).toContain('userId: c.get("userId")');
  });

  it("never exposes an inactive or unapproved instruction through list or load", () => {
    // Both slug/id load conditions in the route, and the list's in search.ts.
    for (const [src, floor] of [
      [rest, 2],
      [search, 1],
    ] as const) {
      expect(
        src.match(/eq\(skills\.status, "active"\)/g)?.length
      ).toBeGreaterThanOrEqual(floor);
      expect(
        src.match(/eq\(skills\.approved, true\)/g)?.length
      ).toBeGreaterThanOrEqual(floor);
      expect(
        src.match(/eq\(skills\.kind, "instruction"\)/g)?.length
      ).toBeGreaterThanOrEqual(floor);
    }
  });

  it("does not let a bearer select another user's identity through userId query parameters", () => {
    const executableRoutes = rest.slice(
      rest.indexOf('app.get("/agent-skills/executable"'),
      rest.indexOf('app.post("/agent-skills/executable"')
    );
    expect(executableRoutes).not.toContain('c.req.query("userId")');
    expect(executableRoutes).toContain('c.get("userId")');
  });
});
