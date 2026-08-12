import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workspaces = readFileSync(
  fileURLToPath(new URL("../../workspaces.ts", import.meta.url)),
  "utf8"
);
// Wave 1 router-decomposition moved workspace/* executors into their own
// domain module; workspace/create and workspace/update are still adjacent
// there (in that order).
const executors = readFileSync(
  fileURLToPath(new URL("../executors/workspace.ts", import.meta.url)),
  "utf8"
);

describe("workspace primary-surface proposal", () => {
  it("uses the workspace/update key and its narrow repository mutation", () => {
    const mutationStart = workspaces.indexOf(
      "setPrimarySurface: protectedProcedure"
    );
    const mutationEnd = workspaces.indexOf(
      "setIntelligenceService:",
      mutationStart
    );
    const mutation = workspaces.slice(mutationStart, mutationEnd);
    expect(mutation).toContain('subjectType: "workspace"');
    expect(mutation).toContain('operation: "set_primary_surface"');

    const createStart = executors.indexOf('key: "workspace/create"');
    const updateStart = executors.indexOf('key: "workspace/update"');
    const nextExecutor = executors.indexOf(
      "registerProposalExecutor",
      updateStart + 1
    );
    const createBlock = executors.slice(createStart, updateStart);
    const updateBlock = executors.slice(updateStart, nextExecutor);

    expect(createBlock).not.toContain('operation === "set_primary_surface"');
    expect(updateBlock).toContain('operation === "set_primary_surface"');
    expect(updateBlock).toContain("workspaceRepo.setPrimarySurface");
  });
});
