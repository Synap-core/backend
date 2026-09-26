/**
 * Overlay packs converge at boot, and their ledger version is EARNED: it
 * advances only when the pack's playbooks converged (invariant 1). The pack is
 * layered with the base's shell stripped — never as the workspace identity.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { reconcileMock, mergeSettingsMock, playbooksMock } = vi.hoisted(() => ({
  reconcileMock: vi.fn(async (_o: Record<string, unknown>) => ({})),
  mergeSettingsMock: vi.fn(async () => ({})),
  playbooksMock: vi.fn(),
}));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  reconcileWorkspaceFromDefinition: reconcileMock,
  WorkspaceRepository: class {
    mergeSettings = mergeSettingsMock;
  },
}));
vi.mock("./playbooks/reconcile-installed-playbooks.js", () => ({
  reconcileWorkspacePlaybooksToTemplate: playbooksMock,
}));

import { reconcileInstalledPacks } from "./reconcile-installed-packs.js";

const resolve = vi.fn(async (slug: string) =>
  slug === "business-model"
    ? ({
        version: "h-2",
        workspaceDefinition: {
          workspaceSubtype: "business-model",
          profiles: [],
        },
        packageDefinition: { playbooks: [{ name: "Business Model (GRP)" }] },
      } as never)
    : null
);
const SETTINGS = {
  packageSlug: "foundation",
  installedPacks: [
    { slug: "business-model", version: "h-1", installedAt: "t0" },
    { slug: "some-view-pack", version: "1", installedAt: "t0" },
  ],
};

describe("reconcileInstalledPacks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("re-syncs the pack additively (no identity) and advances its ledger version", async () => {
    playbooksMock.mockResolvedValue({ results: [], missing: [], failed: [] });
    const out = await reconcileInstalledPacks({
      workspaceId: "ws-f",
      ownerId: "u",
      settings: SETTINGS,
      resolve,
      now: "t1",
    });
    const opts = reconcileMock.mock.calls[0]![0];
    expect(opts.packageSlug).toBeUndefined();
    expect(
      (opts.definition as Record<string, unknown>).workspaceSubtype
    ).toBeUndefined();
    expect(playbooksMock).toHaveBeenCalledWith(
      expect.objectContaining({
        packageSlug: "business-model",
        workspaceId: "ws-f",
      })
    );
    const ledger = (
      (mergeSettingsMock.mock.calls[0] as unknown[])[1] as {
        installedPacks: Array<{ slug: string; version: string }>;
      }
    ).installedPacks;
    expect(ledger.find((p) => p.slug === "business-model")?.version).toBe(
      "h-2"
    );
    expect(out.find((o) => o.slug === "some-view-pack")?.status).toBe(
      "skipped"
    );
  });

  it("WITHHOLDS the version when a playbook failed to converge", async () => {
    playbooksMock.mockResolvedValue({
      results: [],
      missing: [],
      failed: [{ name: "x", error: "boom" }],
    });
    const out = await reconcileInstalledPacks({
      workspaceId: "ws-f",
      ownerId: "u",
      settings: SETTINGS,
      resolve,
    });
    expect(mergeSettingsMock).not.toHaveBeenCalled();
    expect(out.find((o) => o.slug === "business-model")?.status).toBe(
      "partial"
    );
  });
});
