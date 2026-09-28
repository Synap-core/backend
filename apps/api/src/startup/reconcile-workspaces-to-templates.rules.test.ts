/**
 * The boot pass converges TEMPLATE RULES (package `rules[]`) — not only the
 * install door. Before this, a space installed before its template shipped
 * rules never received them: `applyTemplateRules` ran only inside
 * `applyPackagePostWorkspace`.
 *
 * Driven through the real `reconcileWorkspacesToTemplates` with the doors
 * spied. Asserts the template's OWN rules value reaches the rule applier for
 * the right space/owner/template, and that a pass whose rules did not
 * converge withholds the whole-template `packageVersion` stamp.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const RULES = [
  { key: "brand-read-before-generating", intent: "Read the brand first." },
];

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  reconcileWorkspaceFromDefinition: vi.fn(),
  reconcileWorkspacePlaybooksToTemplate: vi.fn(),
  reconcileInstalledPacks: vi.fn(),
  applyTemplateRules: vi.fn(),
  rulesConverged: true,
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@synap/database", () => ({
  workspaces: {
    id: "id",
    ownerId: "ownerId",
    settings: "settings",
    packageSlug: "packageSlug",
    archivedAt: "archivedAt",
  },
  getDb: async () => ({
    select: () => ({ from: async () => h.rows }),
  }),
  reconcileWorkspaceFromDefinition: h.reconcileWorkspaceFromDefinition,
}));

vi.mock("@synap/api", () => ({
  resolveWorkspaceTemplate: async (slug: string) => ({
    version: "2.0.0",
    source: "bundle",
    dependencies: [],
    workspaceDefinition: { flowAutomations: [], commands: [], relationDefs: [] },
    packageDefinition: {
      playbooks: [],
      ...(slug === "brand-library" ? { rules: RULES } : {}),
    },
  }),
  orderWorkspacesByTemplateDependencies: <T>(items: T[]) => items,
  reconcileWorkspacePlaybooksToTemplate:
    h.reconcileWorkspacePlaybooksToTemplate,
  playbookReportConverged: () => true,
  reconcileInstalledPacks: h.reconcileInstalledPacks,
  applyTemplateRules: h.applyTemplateRules,
  templateRulesConverged: () => h.rulesConverged,
}));

import { reconcileWorkspacesToTemplates } from "./reconcile-workspaces-to-templates.js";

/** The domain pass is the call that carries `packageSlug`. */
const domainStamp = () =>
  h.reconcileWorkspaceFromDefinition.mock.calls
    .map((c) => c[0] as { packageSlug?: string; packageVersion?: string })
    .find((a) => a.packageSlug === "brand-library");

describe("reconcileWorkspacesToTemplates — template rules", () => {
  beforeEach(() => {
    h.reconcileWorkspaceFromDefinition.mockReset().mockResolvedValue({
      profiles: { added: [] },
      properties: { added: [], conflicts: [] },
      entityLinks: { added: [] },
      home: { blocksAdded: [] },
      layout: { sidebarItemsAdded: [], primarySurfaceChanged: false },
    });
    h.reconcileWorkspacePlaybooksToTemplate
      .mockReset()
      .mockResolvedValue({ failed: [], results: [] });
    h.reconcileInstalledPacks.mockReset().mockResolvedValue([]);
    h.applyTemplateRules.mockReset().mockResolvedValue([]);
    h.rulesConverged = true;
    h.rows = [
      {
        id: "ws-brand",
        ownerId: "owner-1",
        settings: { packageSlug: "brand-library" },
        packageSlug: "brand-library",
        archivedAt: null,
      },
    ];
  });

  it("hands the template's own rules to the rule applier for that space", async () => {
    await reconcileWorkspacesToTemplates();
    expect(h.applyTemplateRules).toHaveBeenCalledTimes(1);
    expect(h.applyTemplateRules.mock.calls[0]![0]).toEqual({
      workspaceId: "ws-brand",
      userId: "owner-1",
      templateSlug: "brand-library",
      rules: RULES,
    });
  });

  it("stamps the version when rules converged, withholds it when not", async () => {
    await reconcileWorkspacesToTemplates();
    expect(domainStamp()?.packageVersion).toBe("2.0.0");

    h.reconcileWorkspaceFromDefinition.mockClear();
    h.rulesConverged = false;
    await reconcileWorkspacesToTemplates();
    expect(domainStamp()).toBeDefined();
    expect(domainStamp()?.packageVersion).toBeUndefined();
  });

  it("a throwing rule applier costs the stamp, never the space's reconcile", async () => {
    h.applyTemplateRules.mockRejectedValue(new Error("db down"));
    h.rulesConverged = false;
    await reconcileWorkspacesToTemplates();
    expect(domainStamp()).toBeDefined();
    expect(domainStamp()?.packageVersion).toBeUndefined();
  });
});
