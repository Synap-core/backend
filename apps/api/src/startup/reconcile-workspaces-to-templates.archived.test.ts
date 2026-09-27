/**
 * The boot reconcile never touches an ARCHIVED workspace (R7, 2026-09-27).
 *
 * Before: the SELECT had no archived filter, so every boot re-grew a retired
 * workspace — the base pass re-created its deleted "Generate report"
 * automation as active, the domain pass re-added template profiles/views, the
 * pack pass re-synced its overlays. Driven through the real function with the
 * three reconcile doors spied, over one live + one archived workspace that
 * both carry a resolvable template identity, so the ONLY thing separating
 * them is `archivedAt`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const LIVE = "ws-live";
const ARCHIVED = "ws-archived";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  reconcileWorkspaceFromDefinition: vi.fn(),
  reconcileWorkspacePlaybooksToTemplate: vi.fn(),
  reconcileInstalledPacks: vi.fn(),
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
    version: "1.0.0",
    source: "bundle",
    dependencies: [],
    workspaceDefinition: {
      flowAutomations: [],
      commands: [],
      relationDefs: [],
      slug,
    },
    packageDefinition: { playbooks: [] },
  }),
  orderWorkspacesByTemplateDependencies: <T>(items: T[]) => items,
  reconcileWorkspacePlaybooksToTemplate:
    h.reconcileWorkspacePlaybooksToTemplate,
  reconcileInstalledPacks: h.reconcileInstalledPacks,
}));

import { reconcileWorkspacesToTemplates } from "./reconcile-workspaces-to-templates.js";

const touched = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls.map((c) => (c[0] as { workspaceId: string }).workspaceId);

describe("reconcileWorkspacesToTemplates — archived workspaces are frozen", () => {
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
      .mockResolvedValue({ failed: [] });
    h.reconcileInstalledPacks.mockReset().mockResolvedValue([]);
    h.rows = [
      {
        id: LIVE,
        ownerId: "u1",
        settings: { packageSlug: "builder-workspace" },
        packageSlug: "builder-workspace",
        archivedAt: null,
      },
      {
        id: ARCHIVED,
        ownerId: "u1",
        settings: { packageSlug: "dev-dashboard" },
        packageSlug: "dev-dashboard",
        archivedAt: new Date("2026-09-27T00:00:00Z"),
      },
    ];
  });

  it("reconciles the live workspace through every pass (non-vacuity)", async () => {
    await reconcileWorkspacesToTemplates();
    // base pass + domain pass
    expect(
      touched(h.reconcileWorkspaceFromDefinition).filter((id) => id === LIVE)
    ).toHaveLength(2);
    expect(touched(h.reconcileWorkspacePlaybooksToTemplate)).toContain(LIVE);
    expect(touched(h.reconcileInstalledPacks)).toContain(LIVE);
  });

  it("never touches the archived one — base, domain, playbooks, packs", async () => {
    await reconcileWorkspacesToTemplates();
    expect(touched(h.reconcileWorkspaceFromDefinition)).not.toContain(ARCHIVED);
    expect(touched(h.reconcileWorkspacePlaybooksToTemplate)).not.toContain(
      ARCHIVED
    );
    expect(touched(h.reconcileInstalledPacks)).not.toContain(ARCHIVED);
  });
});
