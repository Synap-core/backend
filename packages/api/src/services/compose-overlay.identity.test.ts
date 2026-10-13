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

const { reconcileMock, upsertPackMock, baseRow, recorded } = vi.hoisted(() => ({
  reconcileMock: vi.fn(async (_opts: Record<string, unknown>) => ({})),
  upsertPackMock: vi.fn(),
  baseRow: { current: {} as Record<string, unknown> },
  /** The pack list the ONE writer would store (real `withPack` merge). */
  recorded: {
    packs: [] as Array<{ slug: string; version: string | null }>,
  },
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
    // The template-state writer, applied to the stored row with the REAL
    // merge (`withPack`) so the ledger it would write is asserted.
    upsertPack: upsertPackMock.mockImplementation(
      async (_db: unknown, _id: string, pack: { slug: string }) => {
        recorded.packs = actual.withPack(
          actual.readTemplateState(
            (baseRow.current as { settings?: unknown }).settings
          )?.packs,
          pack,
          "t1"
        );
        return null;
      }
    ),
  };
});
vi.mock("../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: vi.fn(async () => undefined),
}));

import {
  composeOntoBaseWorkspace,
  overlayDefinitionForIdentifiedBase,
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
    upsertPackMock.mockClear();
    recorded.packs = [];
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
    const report = await composeOntoBaseWorkspace({
      composeTargetWorkspaceId: "ws-foundation",
      userId: "u",
      definition: OVERLAY,
      packageSlug: "business-model",
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
    expect(upsertPackMock).toHaveBeenCalledTimes(1);
    expect(recorded.packs.map((p) => p.slug).sort()).toEqual([
      "business-model",
      "other",
    ]);
    // The pack is RECORDED, but its version is not: layer 2 has not run. The
    // caller's finisher records `pendingPack.version` once it converged.
    expect(
      recorded.packs.find((p) => p.slug === "business-model")?.version
    ).toBeNull();
    expect(recorded.packs.find((p) => p.slug === "other")?.version).toBe("1");
    expect(report.pendingPack).toEqual({
      slug: "business-model",
      version: "h-bm",
    });
  });

  it("--onto an UNIDENTIFIED workspace makes the slug its identity (unchanged)", async () => {
    baseRow.current = {
      id: "ws-bare",
      ownerId: "u",
      packageSlug: null,
      settings: {},
    };
    const report = await composeOntoBaseWorkspace({
      composeTargetWorkspaceId: "ws-bare",
      userId: "u",
      definition: OVERLAY,
      packageSlug: "business-model",
      overlay: { slug: "business-model", version: "h-bm" },
    });
    const opts = reconcileMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.packageSlug).toBe("business-model");
    // The VERSION is never written by compose: the caller's finisher stamps it
    // once layer 2 converged (`identityStamped` tells materialize to hand it back).
    expect(opts.packageVersion).toBeUndefined();
    expect(report.identityStamped).toBe(true);
    expect(upsertPackMock).not.toHaveBeenCalled();
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
    expect(recorded.packs.map((p) => p.slug)).toEqual(["grants"]);
  });
});

describe("pure helpers", () => {
  it("overlayDefinitionForIdentifiedBase keeps sidebar items", () => {
    const d = overlayDefinitionForIdentifiedBase(OVERLAY) as unknown as {
      layoutConfig: { sidebarItems: unknown[] };
    };
    expect(d.layoutConfig.sidebarItems).toHaveLength(1);
  });
});
