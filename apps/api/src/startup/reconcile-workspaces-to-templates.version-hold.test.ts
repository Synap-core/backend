/**
 * The boot pass's version stamp (TEMPLATE-LIFECYCLE Contract C + backend-rules
 * marker invariant): the version reaches the one finisher's boot channel
 * (`finishBootConvergence`) only for what this pass CHECKED.
 *
 * W4 moved this hold out of `reconcileWorkspaceFromDefinition` (its seam test
 * was `reconcile-workspace-version-hold.test.ts` in @synap/database) into the
 * boot pass, which now owns the decision; the channel itself holds the stamp
 * while the space's last apply is unfinished (pinned on PGlite by
 * `template-apply-finisher.boot.pglite.test.ts`).
 *
 * Driven through the real `reconcileWorkspacesToTemplates`; `readTemplateState`
 * is the REAL one, and the assertion is on what reached the channel. The
 * data-change hold (Contract C) is the channel's own (one place for every
 * stamp): this pass never reads pending changes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  pending: vi.fn(),
  finishBootConvergence: vi.fn(),
  playbooksConverged: true,
}));

vi.mock("@synap-core/core", () => ({
  ConflictError: class ConflictError extends Error {},
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@synap/database", async () => ({
  readTemplateState: (
    await vi.importActual<
      typeof import("../../../../packages/database/src/utils/template-state.js")
    >("../../../../packages/database/src/utils/template-state.js")
  ).readTemplateState,
  holdsTemplateStamp: (
    await vi.importActual<
      typeof import("../../../../packages/database/src/conversions/data-changes.js")
    >("../../../../packages/database/src/conversions/data-changes.js")
  ).holdsTemplateStamp,
  pendingTemplateDataChanges: (...a: unknown[]) => h.pending(...a),
  sql: {},
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
  reconcileWorkspaceFromDefinition: async () => ({
    profiles: { added: [] },
    properties: { added: [], conflicts: [] },
    entityLinks: { added: [] },
    home: { blocksAdded: [] },
    layout: { sidebarItemsAdded: [], primarySurfaceChanged: false },
  }),
}));

vi.mock("@synap/api", () => ({
  resolveWorkspaceTemplate: async () => ({
    version: "2.0.0",
    source: "bundle",
    dependencies: [],
    workspaceDefinition: {
      profiles: [{ slug: "deal" }],
      flowAutomations: [],
      commands: [],
      relationDefs: [],
    },
    packageDefinition: { playbooks: [] },
  }),
  orderWorkspacesByTemplateDependencies: <T>(items: T[]) => items,
  reconcileWorkspacePlaybooksToTemplate: async () => ({
    failed: [],
    results: [],
  }),
  playbookReportConverged: () => h.playbooksConverged,
  reconcileInstalledPacks: async () => [],
  resolveTemplateCatalog: async () => null,
  readOverlayLedger: () => [],
  applyTemplateRules: async () => [],
  templateRulesConverged: () => true,
  reconcileBaseDefaults: async () => "reconciled",
  finishBootConvergence: h.finishBootConvergence,
}));

import { reconcileWorkspacesToTemplates } from "./reconcile-workspaces-to-templates.js";

const change = (opKey: string, destructive: boolean) => ({
  opKey,
  description: opKey,
  affected: 3,
  destructive,
  counts: {},
});

const bootCall = () =>
  h.finishBootConvergence.mock.calls[0]?.[0] as
    | {
        template?: {
          version: string;
          templatePackage: Record<string, unknown>;
          converged: string[];
        };
      }
    | undefined;
const stampedVersion = () => bootCall()?.template?.version;

beforeEach(() => {
  h.pending.mockReset();
  h.finishBootConvergence.mockReset().mockResolvedValue({
    versionStamped: true,
    packsRecorded: 0,
    uncovered: [],
  });
  h.playbooksConverged = true;
  h.rows = [
    {
      id: "ws-crm",
      ownerId: "owner-1",
      settings: { packageSlug: "crm", packageVersion: "1.0.0" },
      packageSlug: "crm",
      archivedAt: null,
    },
  ];
});

describe("boot pass — the version stamp waits for what it checked", () => {
  it("the data-change hold is the CHANNEL's: the pass hands the converged template over and never reads pending changes itself", async () => {
    // (Contract C is decided in ONE place every stamp passes through — the
    // finisher; pinned on PGlite by template-apply-finisher.boot.pglite.)
    h.pending.mockResolvedValue([change("crm.deal", false)]);
    await reconcileWorkspacesToTemplates();
    expect(h.pending).not.toHaveBeenCalled();
    expect(stampedVersion()).toBe("2.0.0");
  });

  it("playbooks that did not converge hold it too", async () => {
    h.pending.mockResolvedValue([]);
    h.playbooksConverged = false;
    await reconcileWorkspacesToTemplates();
    expect(h.finishBootConvergence).not.toHaveBeenCalled();
  });

  it("a space already at the version is not written again", async () => {
    h.pending.mockResolvedValue([]);
    h.rows[0]!.settings = { packageSlug: "crm", packageVersion: "2.0.0" };
    await reconcileWorkspacesToTemplates();
    expect(h.finishBootConvergence).not.toHaveBeenCalled();
  });

  it("hands the channel the RESOLVED package and exactly what this pass converged (playbooks + rules) — the channel judges coverage from them (review F3)", async () => {
    h.pending.mockResolvedValue([]);
    await reconcileWorkspacesToTemplates();
    expect(bootCall()?.template).toEqual({
      version: "2.0.0",
      templatePackage: { playbooks: [] },
      converged: ["playbooks", "rules"],
    });
  });
});
