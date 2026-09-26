/**
 * Overlay identity — a pack/template layered onto a workspace that has its OWN
 * template identity must never overwrite it; it is recorded in
 * `settings.installedPacks` instead (the GRP-on-Foundation blocker).
 *
 * Before: `--onto` stamped `packageSlug = business-model` over Foundation's
 * `foundation` (so Foundation stopped reconciling to foundation.yaml), the
 * overlay's `workspaceSubtype` overwrote Foundation's, and NOTHING wrote
 * `installedPacks` server-side — so a composed pack could never re-sync nor
 * show drift. The discriminating rows: an IDENTIFIED base (must keep identity,
 * record the pack) vs an UNIDENTIFIED base (the `--onto` slug becomes its
 * identity, as before) — a rule that always/never stamps fails one of them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { reconcileMock, mergeSettingsMock, baseRow } = vi.hoisted(() => ({
  reconcileMock: vi.fn(async (_opts: Record<string, unknown>) => ({})),
  mergeSettingsMock: vi.fn(async () => ({})),
  baseRow: { current: {} as Record<string, unknown> },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [baseRow.current],
  };
  return {
    ...actual,
    db: { select: () => chain },
    reconcileWorkspaceFromDefinition: reconcileMock,
    WorkspaceRepository: class {
      mergeSettings = mergeSettingsMock;
    },
  };
});
vi.mock("../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: vi.fn(async () => undefined),
}));

import {
  composeOntoBaseWorkspace,
  overlayDefinitionForIdentifiedBase,
  upsertInstalledPack,
} from "./compose-overlay.js";

const OVERLAY = {
  workspaceSubtype: "business-model",
  workspaceVisibility: "private",
  layoutConfig: {
    primarySurface: { kind: "view", slug: "grp" },
    sidebarItems: [{ kind: "view", slug: "grp" }],
  },
  profiles: [{ slug: "convention" }],
} as never;

describe("composeOntoBaseWorkspace — overlay identity", () => {
  beforeEach(() => {
    reconcileMock.mockClear();
    mergeSettingsMock.mockClear();
  });

  it("--onto an IDENTIFIED workspace keeps its identity and records the pack", async () => {
    baseRow.current = {
      id: "ws-foundation",
      ownerId: "u",
      packageSlug: "foundation",
      settings: {
        packageSlug: "foundation",
        installedPacks: [{ slug: "other", version: "1", installedAt: "t0" }],
      },
    };
    await composeOntoBaseWorkspace({
      composeTargetWorkspaceId: "ws-foundation",
      userId: "u",
      definition: OVERLAY,
      packageSlug: "business-model",
      packageVersion: "h-bm",
      overlay: { slug: "business-model", version: "h-bm" },
    });
    const opts = reconcileMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.packageSlug).toBeUndefined();
    expect(opts.packageVersion).toBeUndefined();
    const def = opts.definition as Record<string, unknown>;
    expect(def.workspaceSubtype).toBeUndefined();
    expect(def.workspaceVisibility).toBeUndefined();
    expect(
      (def.layoutConfig as Record<string, unknown>).primarySurface
    ).toBeUndefined();
    // Additive layers still travel.
    expect(def.profiles).toEqual([{ slug: "convention" }]);
    expect(mergeSettingsMock).toHaveBeenCalledTimes(1);
    const patch = (mergeSettingsMock.mock.calls[0] as unknown[])[1] as {
      installedPacks: Array<{ slug: string; version: string }>;
    };
    expect(patch.installedPacks.map((p) => p.slug).sort()).toEqual([
      "business-model",
      "other",
    ]);
    expect(
      patch.installedPacks.find((p) => p.slug === "business-model")?.version
    ).toBe("h-bm");
  });

  it("--onto an UNIDENTIFIED workspace makes the slug its identity (unchanged)", async () => {
    baseRow.current = {
      id: "ws-bare",
      ownerId: "u",
      packageSlug: null,
      settings: {},
    };
    await composeOntoBaseWorkspace({
      composeTargetWorkspaceId: "ws-bare",
      userId: "u",
      definition: OVERLAY,
      packageSlug: "business-model",
      packageVersion: "h-bm",
      overlay: { slug: "business-model", version: "h-bm" },
    });
    const opts = reconcileMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.packageSlug).toBe("business-model");
    expect(opts.packageVersion).toBe("h-bm");
    expect(mergeSettingsMock).not.toHaveBeenCalled();
  });

  it("a NATURAL compose records the overlay without stamping identity", async () => {
    baseRow.current = {
      id: "ws-ops",
      ownerId: "u",
      packageSlug: "operations",
      settings: { packageSlug: "operations" },
    };
    await composeOntoBaseWorkspace({
      composeTargetWorkspaceId: "ws-ops",
      userId: "u",
      definition: OVERLAY,
      overlay: { slug: "grants", version: "h-g" },
    });
    const opts = reconcileMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.packageSlug).toBeUndefined();
    const patch = (mergeSettingsMock.mock.calls[0] as unknown[])[1] as {
      installedPacks: Array<{ slug: string }>;
    };
    expect(patch.installedPacks.map((p) => p.slug)).toEqual(["grants"]);
  });
});

describe("pure helpers", () => {
  it("upsertInstalledPack refreshes the version and keeps the first installedAt", () => {
    const next = upsertInstalledPack(
      [{ slug: "grants", version: "h-1", installedAt: "t0" }],
      { slug: "grants", version: "h-2" },
      "t1"
    );
    expect(next).toEqual([
      { slug: "grants", version: "h-2", installedAt: "t0" },
    ]);
  });

  it("overlayDefinitionForIdentifiedBase keeps sidebar items", () => {
    const d = overlayDefinitionForIdentifiedBase(OVERLAY) as unknown as {
      layoutConfig: { sidebarItems: unknown[] };
    };
    expect(d.layoutConfig.sidebarItems).toHaveLength(1);
  });
});
