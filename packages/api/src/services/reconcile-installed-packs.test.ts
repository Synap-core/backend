/**
 * Overlay packs converge at boot, and their ledger version is EARNED: it
 * advances only when the pack's playbooks converged (invariant 1). The pack is
 * layered with the base's shell stripped — never as the workspace identity.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { reconcileMock, writeMock, playbooksMock, stored } = vi.hoisted(() => ({
  reconcileMock: vi.fn(async (_o: Record<string, unknown>) => ({})),
  writeMock: vi.fn(),
  playbooksMock: vi.fn(),
  /** The row the ONE writer would lock and merge onto. */
  stored: { settings: {} as unknown },
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    reconcileWorkspaceFromDefinition: reconcileMock,
    // The template-state writer, with the REAL reader + merge applied to the
    // stored row: what it returns is the state it would write.
    writeTemplateState: writeMock.mockImplementation(
      async (_db: unknown, _id: string, patch: unknown) => {
        const current = actual.readTemplateState(stored.settings);
        const change =
          typeof patch === "function" ? patch(current) : (patch as object);
        return change ? actual.mergeTemplateState(current, change, "t") : null;
      }
    ),
  };
});
vi.mock(
  "./playbooks/reconcile-installed-playbooks.js",
  async (importOriginal) => ({
    // The REAL convergence predicate; only the effectful reconcile is stubbed.
    ...(await importOriginal<
      typeof import("./playbooks/reconcile-installed-playbooks.js")
    >()),
    reconcileWorkspacePlaybooksToTemplate: playbooksMock,
  })
);

import { reconcileInstalledPacks } from "./reconcile-installed-packs.js";
import type { TemplateCatalogView } from "./template-health.js";

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
  beforeEach(() => {
    vi.clearAllMocks();
    stored.settings = SETTINGS;
  });

  it("re-syncs the pack additively (no identity) and advances its ledger version", async () => {
    playbooksMock.mockResolvedValue({ results: [], missing: [], failed: [] });
    const out = await reconcileInstalledPacks({
      workspaceId: "ws-f",
      ownerId: "u",
      settings: SETTINGS,
      resolve,
      catalog: null,
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
    const written = await writeMock.mock.results[0]!.value;
    const ledger = written.packs as Array<{ slug: string; version: string }>;
    // The other ledger entry survives (merged onto the stored row).
    expect(ledger.map((p) => p.slug).sort()).toEqual([
      "business-model",
      "some-view-pack",
    ]);
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
      catalog: null,
    });
    expect(writeMock).not.toHaveBeenCalled();
    expect(out.find((o) => o.slug === "business-model")?.status).toBe(
      "partial"
    );
  });

  // The discriminating row: no failure, but the change was only PROPOSED
  // (queued for review). A failed-only check advances the stamp here.
  it("WITHHOLDS the version when a playbook change was only proposed", async () => {
    playbooksMock.mockResolvedValue({
      results: [
        {
          playbookId: "pb-1",
          name: "Business Model (GRP)",
          kind: "proposed",
          applied: ["stages"],
          ownerOwned: [],
        },
      ],
      missing: [],
      failed: [],
    });
    const out = await reconcileInstalledPacks({
      workspaceId: "ws-f",
      ownerId: "u",
      settings: SETTINGS,
      resolve,
      catalog: null,
    });
    expect(writeMock).not.toHaveBeenCalled();
    const bm = out.find((o) => o.slug === "business-model");
    expect(bm?.status).toBe("partial");
    expect(bm?.playbooks?.proposed).toBe(1);
  });
});

// The skip says WHY, from the same standing template health reports — and a
// catalog that could not be read is "catalog unknown", never "not there".
describe("reconcileInstalledPacks — an unresolvable overlay says why it was skipped", () => {
  beforeEach(() => vi.clearAllMocks());
  const entry = (retired: boolean, replacedBy: string | null = null) => ({
    version: retired ? null : "h-1",
    retired,
    replacedBy,
    retiredReason: retired ? "gone" : null,
  });
  const catalog = (complete: boolean): TemplateCatalogView => ({
    latestBySlug: new Map([["live-but-unfetchable", "h-1"]]),
    entryBySlug: new Map([
      ["business-developer", entry(true, "crm")],
      ["old-thing", entry(true)],
      ["live-but-unfetchable", entry(false)],
    ]),
    complete,
  });
  const settings = {
    packageSlug: "crm",
    installedPacks: [
      "business-developer",
      "old-thing",
      "some-profile-pack",
      "live-but-unfetchable",
    ].map((slug) => ({ slug, version: "h-1", installedAt: "t0" })),
  };
  const run = (c: TemplateCatalogView | null) =>
    reconcileInstalledPacks({
      workspaceId: "ws-crm",
      ownerId: "u",
      settings,
      resolve: async () => null,
      catalog: c,
    });

  it("names retired (and by what), not in the catalog, and fetch failure apart", async () => {
    const out = await run(catalog(true));
    expect(out.every((o) => o.status === "skipped")).toBe(true);
    expect(reconcileMock).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled(); // ledger untouched
    const by = new Map(out.map((o) => [o.slug, o]));
    expect(by.get("business-developer")).toMatchObject({
      lifecycle: "retired",
      replacedBy: "crm",
      reason: 'retired, replaced by "crm"',
    });
    expect(by.get("old-thing")).toMatchObject({
      lifecycle: "retired",
      replacedBy: null,
      reason: "retired, no replacement",
    });
    expect(by.get("some-profile-pack")).toMatchObject({
      lifecycle: "unlisted",
      reason: "not in the template catalog",
    });
    expect(by.get("live-but-unfetchable")).toMatchObject({
      lifecycle: "current",
      reason: "in the catalog, but its definition could not be fetched",
    });
  });

  it("an incomplete catalog never claims an absent overlay is not in it", async () => {
    const out = await run(catalog(false));
    expect(out.find((o) => o.slug === "some-profile-pack")).toMatchObject({
      lifecycle: "unknown",
      reason: expect.stringMatching(/^catalog unknown/),
    });
    // A tombstone is known regardless of completeness.
    expect(out.find((o) => o.slug === "business-developer")?.lifecycle).toBe(
      "retired"
    );
  });

  it("a catalog read that FAILED makes every skip `unknown`, never `unlisted`", async () => {
    const out = await run(null);
    expect(out).toHaveLength(4);
    for (const o of out) {
      expect(o.lifecycle).toBe("unknown");
      expect(o.reason).toBe(
        "catalog unknown: the template catalog could not be read"
      );
    }
  });
});
