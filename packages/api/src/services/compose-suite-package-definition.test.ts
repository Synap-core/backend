/**
 * composeSuitePackageDefinition — two fake workspaces → suite shape.
 *
 * Pins the Wave F contract: tags include `suite`, dependencies `require`
 * both slugs (NOT compose), playbooks from the constituents are embedded.
 */

import { describe, it, expect } from "vitest";
import {
  composeSuitePackageDefinition,
  slugifyPackageName,
  SUITE_TAG,
} from "./compose-suite-package-definition.js";
import type { PackageDefinition } from "@synap/database";

function fakeWorkspace(
  slug: string,
  playbooks: NonNullable<PackageDefinition["playbooks"]> = []
): PackageDefinition {
  return {
    _meta: { slug },
    workspaceName: slug,
    description: `${slug} workspace`,
    profiles: [
      {
        slug: "thing",
        displayName: "Thing",
        properties: [{ slug: "title", label: "Title", valueType: "string" }],
      },
    ],
    ...(playbooks.length > 0 ? { playbooks } : {}),
  };
}

describe("composeSuitePackageDefinition", () => {
  it("tags include suite and dependencies require both workspace slugs", () => {
    const def = composeSuitePackageDefinition({
      projectName: "Acme Launch",
      projectDescription: "Go-to-market for Acme",
      workspaceDefs: [
        fakeWorkspace("crm", [
          {
            name: "Qualify lead",
            goalTemplate: "Qualify {{lead}}",
          },
        ]),
        fakeWorkspace("content-os", [
          {
            name: "Draft post",
            goalTemplate: "Draft {{topic}}",
          },
        ]),
      ],
    });

    expect(def._meta?.tags).toContain(SUITE_TAG);
    expect(def._meta?.slug).toBe("acme-launch");
    expect(def.workspaceName).toBe("Acme Launch");
    expect(def.description).toBe("Go-to-market for Acme");

    expect(def.dependencies).toEqual([
      {
        slug: "crm",
        kind: "workspace",
        relation: "require",
        reason: "Workspace lens required by the Acme Launch suite.",
      },
      {
        slug: "content-os",
        kind: "workspace",
        relation: "require",
        reason: "Workspace lens required by the Acme Launch suite.",
      },
    ]);
    // require, never compose — re-apply must not duplicate workspaces.
    for (const d of def.dependencies ?? []) {
      expect(d.relation).toBe("require");
      expect(d.relation).not.toBe("compose");
    }

    expect(def.playbooks?.map((p) => p.name)).toEqual([
      "Qualify lead",
      "Draft post",
    ]);
    // Thin command-tower profile so CP workspace publish accepts the suite.
    expect(def.profiles?.length).toBeGreaterThanOrEqual(1);
  });

  it("caller must publish workspaceDefs as constituents separately (suite stays thin)", () => {
    // Contract: composeSuite only builds the tower + require deps. Depth lives
    // in the input workspaceDefs — projectToSuite returns them as constituents.
    const crm = fakeWorkspace("crm");
    const content = fakeWorkspace("content-os");
    const def = composeSuitePackageDefinition({
      projectName: "Acme",
      workspaceDefs: [crm, content],
    });
    expect(def.profiles?.[0]?.slug).toBe("suite-home");
    expect(def.views).toBeUndefined();
    expect(def.cells).toBeUndefined();
    // Constituents are the full defs the CLI publishes first.
    expect([crm, content].map((d) => d._meta?.slug)).toEqual([
      "crm",
      "content-os",
    ]);
  });

  it("dedupes duplicate workspace slugs and playbook names", () => {
    const def = composeSuitePackageDefinition({
      projectName: "Dupes",
      workspaceDefs: [
        fakeWorkspace("crm", [{ name: "Qualify lead", goalTemplate: "A" }]),
        fakeWorkspace("crm", [
          { name: "Qualify lead", goalTemplate: "B" },
          { name: "Other", goalTemplate: "C" },
        ]),
      ],
    });
    expect(def.dependencies).toHaveLength(1);
    expect(def.dependencies?.[0]?.slug).toBe("crm");
    expect(def.playbooks?.map((p) => p.name)).toEqual([
      "Qualify lead",
      "Other",
    ]);
    expect(def.playbooks?.[0]?.goalTemplate).toBe("A");
  });

  it("refuses an empty workspace list", () => {
    expect(() =>
      composeSuitePackageDefinition({
        projectName: "Empty",
        workspaceDefs: [],
      })
    ).toThrow(/uses no workspaces/);
  });

  it("refuses a workspace def without _meta.slug", () => {
    expect(() =>
      composeSuitePackageDefinition({
        projectName: "Broken",
        workspaceDefs: [{ workspaceName: "No Slug" }],
      })
    ).toThrow(/no _meta\.slug/);
  });
});

describe("slugifyPackageName", () => {
  it("kebab-cases and keeps a leading letter", () => {
    expect(slugifyPackageName("Acme Launch")).toBe("acme-launch");
    expect(slugifyPackageName("  Hello_World  ")).toBe("hello-world");
  });

  it("prefixes when the name would start with a digit", () => {
    expect(slugifyPackageName("2026 Plan")).toBe("s-2026-plan");
  });
});
