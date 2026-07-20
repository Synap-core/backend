import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "execute-capability.ts"
);

/**
 * `skillId` is a convenience selector, never an authorization grant. These
 * source-level cases guard the shared execute resolver without requiring a
 * database fixture for every Pod scope combination.
 */
describe("executeCapability direct skillId visibility and lifecycle contract", () => {
  const src = readFileSync(FILE, "utf8");
  const resolver = src.slice(
    src.indexOf("const [skillRow]"),
    src.indexOf("if (!skillRow)")
  );

  it("does not resolve a foreign user skill id outside the canonical caller lens", () => {
    expect(resolver).toContain(
      "visibleSkillsWhere(userId, workspaceId ?? undefined)"
    );
  });

  it("does not resolve a foreign workspace skill id without the shared membership predicate", () => {
    expect(resolver).toContain(
      "visibleSkillsWhere(userId, workspaceId ?? undefined)"
    );
  });

  it("does not resolve an inactive direct skill id", () => {
    expect(resolver).toContain('eq(skills.status, "active")');
  });

  it("applies the same visibility and lifecycle conditions to skillId and verbId", () => {
    expect(resolver).toMatch(
      /skillId\s*\?\s*eq\(skills\.id, skillId\)\s*:\s*eq\(skills\.name, verbId!\)/
    );
    expect(resolver).not.toMatch(
      /skillId\s*\?\s*eq\(skills\.id, skillId\)\s*:\s*and\(/
    );
  });
});
