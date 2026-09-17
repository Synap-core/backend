/**
 * Orient must project the project→workspace uses INDEX so agents discover
 * spans without a second invented door.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  "../services/discover/discover.ts"
);

describe("orient projects carry usedWorkspaces", () => {
  it("DiscoverProject and the projectsOut map include usedWorkspaces", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).toMatch(/usedWorkspaces:\s*UsedWorkspaceRef/);
    expect(src).toMatch(/hydrateUsedWorkspaces/);
    expect(src).toMatch(/listWorkspacesUsedByProjects/);
    expect(src).toMatch(/usedWorkspaces:\s*ids/);
  });
});
