/**
 * preflightWorkspaceFromDefinition — write-free structural-validation pass.
 *
 * These cases exercise ONLY the paths that return BEFORE any database access
 * (structural schema + cross-reference validation), so they are pure and need
 * no live Postgres — proving the door reports the same structural failures the
 * create door throws on, and that it writes nothing on the way there.
 *
 * The profileKind-conflict / reuse / deferred branches run the live resolver
 * (`resolveProfileForApply`) and therefore require Postgres — they are covered
 * by the same live-PG harness as `reconcile-workspace-from-definition.test.ts`
 * and by dogfooding, not here.
 */

import { describe, it, expect } from "vitest";
import {
  preflightWorkspaceFromDefinition,
  type WorkspaceDefinitionInput,
} from "../utils/create-workspace-from-definition.js";

describe("preflightWorkspaceFromDefinition — structural validation (write-free)", () => {
  it("reports an entityLink referencing an undefined profile and stops before resolving", async () => {
    const definition: WorkspaceDefinitionInput = {
      workspaceName: "Preflight Test",
      profiles: [{ slug: "client", displayName: "Client" }],
      entityLinks: [
        {
          sourceProfileSlug: "client",
          targetProfileSlug: "ghost",
          type: "refers",
        },
      ],
    };

    const report = await preflightWorkspaceFromDefinition({
      definition,
      userId: "preflight-user",
    });

    expect(report.dryRun).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.validationErrors.join("\n")).toContain("ghost");
    // Returned at the validation gate → resolver never ran, nothing collected.
    expect(report.profiles.create).toEqual([]);
    expect(report.profiles.reused).toEqual([]);
  });

  it("reports a duplicate profile slug", async () => {
    const definition: WorkspaceDefinitionInput = {
      workspaceName: "Preflight Dup",
      profiles: [
        { slug: "task", displayName: "Task" },
        { slug: "task", displayName: "Task Again" },
      ],
    };

    const report = await preflightWorkspaceFromDefinition({
      definition,
      userId: "preflight-user",
    });

    expect(report.ok).toBe(false);
    expect(report.validationErrors.join("\n")).toContain("duplicated");
  });

  it("reports a schema-shaped error (profiles must be an array)", async () => {
    const report = await preflightWorkspaceFromDefinition({
      // Deliberately malformed to trip the Zod schema before any DB access.
      definition: {
        profiles: "not-an-array",
      } as unknown as WorkspaceDefinitionInput,
      userId: "preflight-user",
    });

    expect(report.ok).toBe(false);
    expect(report.validationErrors.join("\n")).toContain("Schema error");
  });
});
