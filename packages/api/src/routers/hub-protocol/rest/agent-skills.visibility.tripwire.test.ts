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

/**
 * The agent-skill REST catalog is an external read surface, not a management
 * API. These guards prevent a future convenient query from bypassing the same
 * visibility, active-lifecycle, and approval gates as the canonical resolver.
 */
describe("tripwire: external agent-skill reads keep canonical visibility gates", () => {
  const rest = readFileSync(REST_FILE, "utf8");
  const router = readFileSync(ROUTER_FILE, "utf8");

  it("shares the three-tier visibility predicate with the canonical skills router", () => {
    expect(router).toContain("visibleSkillsWhere(userId, input?.workspaceId)");
    expect(
      rest.match(/visibleSkillsWhere\(c\.get\("userId"\)/g)?.length
    ).toBeGreaterThanOrEqual(3);
  });

  it("never exposes an inactive or unapproved instruction through list or load", () => {
    // One list condition plus both slug/id load conditions.
    expect(
      rest.match(/eq\(skills\.status, "active"\)/g)?.length
    ).toBeGreaterThanOrEqual(3);
    expect(
      rest.match(/eq\(skills\.approved, true\)/g)?.length
    ).toBeGreaterThanOrEqual(3);
    expect(
      rest.match(/eq\(skills\.kind, "instruction"\)/g)?.length
    ).toBeGreaterThanOrEqual(3);
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
