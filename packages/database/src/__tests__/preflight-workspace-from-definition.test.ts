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

  it("allows entityLinks + view scopes referencing pod-wide SYSTEM profiles without declaring them (Operations-shaped)", async () => {
    // Regression for the 422 blocker: a template legitimately references seeded
    // pod-wide profiles (company, person, task, …) WITHOUT re-declaring them.
    // The PUBLISH validator allows this (own ∪ SYSTEM_PROFILES); the pod's
    // cross-ref check used to reject it, so such templates published green but
    // failed to apply. With no declared profiles the resolver loop issues zero
    // queries, so `ok` is computed purely (no live Postgres) — the system-seeded
    // known/resolved sets keep the link + view scope resolved end-to-end.
    const definition: WorkspaceDefinitionInput = {
      workspaceName: "Operations",
      profiles: [],
      views: [
        { name: "Companies", type: "table", scopeProfileSlug: "company" },
      ],
      suggestedEntities: [{ title: "Acme", profileSlug: "company" }],
      entityLinks: [
        {
          sourceProfileSlug: "company",
          targetProfileSlug: "person",
          type: "employs",
        },
      ],
    };

    const report = await preflightWorkspaceFromDefinition({
      definition,
      userId: "preflight-user",
    });

    expect(report.validationErrors).toEqual([]);
    expect(report.entityLinks.unresolved).toEqual([]);
    expect(report.views.wouldOrphan).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("still rejects a reference to a genuinely-unknown profile (not declared, not a system profile)", async () => {
    const definition: WorkspaceDefinitionInput = {
      workspaceName: "Operations Typo",
      profiles: [],
      entityLinks: [
        // `company` is a system profile (fine); `persn` is a typo → must fail.
        {
          sourceProfileSlug: "company",
          targetProfileSlug: "persn",
          type: "employs",
        },
      ],
    };

    const report = await preflightWorkspaceFromDefinition({
      definition,
      userId: "preflight-user",
    });

    expect(report.ok).toBe(false);
    expect(report.validationErrors.join("\n")).toContain("persn");
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
