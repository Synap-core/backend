/**
 * applyPackagePostWorkspace stamps every automation it installs with the
 * package that installed it (`metadata.installedByPackage` = `_meta.slug`)
 * through the ONE server stamp (`stampInstalledByPackage`), which keeps the
 * package that first installed a row. The stamp `assertNoNamedClash` exempts
 * is server-owned: an author's own `installedByPackage` never reaches the
 * automation, with or without a package identity.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  create: vi.fn(async (_input: unknown) => ({ status: "created", id: "a1" })),
  update: vi.fn(async (_input: unknown) => ({ status: "updated" })),
  stamp: vi.fn(async (_id: string, _slug: string) => undefined),
  existingAutomation: [] as Array<{ id: string; metadata: unknown }>,
}));

vi.mock("./capabilities/create-from-definition.js", () => ({
  createCapabilityFromDefinition: vi.fn(),
  loadCapabilityTemplate: vi.fn(),
}));
vi.mock("../routers/automations.js", () => ({
  automationsRouter: {
    createCaller: () => ({ create: h.create, update: h.update }),
  },
}));
vi.mock("../routers/hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: vi.fn(async () => ({})),
}));
vi.mock("./automations/server-metadata.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stampInstalledByPackage: h.stamp,
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => h.existingAutomation }),
        }),
      }),
    },
  };
});

import { applyPackagePostWorkspace } from "./package-apply-post-workspace.js";

const WS = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const AUTO = {
  name: "Daily digest",
  key: "crm.digest",
  triggerType: "cron" as const,
  triggerConfig: {},
  metadata: { kind: "digest", installedByPackage: "forged" },
};

const metadataOf = (fn: { mock: { calls: unknown[][] } }) =>
  (fn.mock.calls[0]?.[0] as { metadata?: Record<string, unknown> }).metadata;

beforeEach(() => {
  h.create.mockClear();
  h.update.mockClear();
  h.stamp.mockClear();
  h.create.mockImplementation(async () => ({ status: "created", id: "a1" }));
  h.existingAutomation = [];
});

describe("automations carry the package that installed them", () => {
  it("stamps a created automation with _meta.slug; the author's own value never reaches it", async () => {
    await applyPackagePostWorkspace({
      workspaceId: WS,
      userId: USER,
      body: { automations: [AUTO], _meta: { slug: "acme/crm-pack" } },
    });
    expect(metadataOf(h.create)).toEqual({
      kind: "digest",
      templateKey: "crm.digest",
    });
    expect(h.stamp).toHaveBeenCalledWith("a1", "acme/crm-pack");
  });

  it("stamps a reused automation (the stamp keeps a first installer's)", async () => {
    h.existingAutomation = [
      { id: "a9", metadata: { templateKey: "crm.digest" } },
    ];
    await applyPackagePostWorkspace({
      workspaceId: WS,
      userId: USER,
      body: { automations: [AUTO], _meta: { slug: "acme/crm-pack" } },
    });
    expect(metadataOf(h.update)).toEqual({
      templateKey: "crm.digest",
      kind: "digest",
    });
    expect(h.stamp).toHaveBeenCalledWith("a9", "acme/crm-pack");
  });

  it("a definition with no package identity stamps nothing, and its forged stamp is dropped", async () => {
    await applyPackagePostWorkspace({
      workspaceId: WS,
      userId: USER,
      body: { automations: [AUTO] },
    });
    expect(metadataOf(h.create)).toEqual({
      kind: "digest",
      templateKey: "crm.digest",
    });
    expect(h.stamp).not.toHaveBeenCalled();
  });

  it("a proposed automation is not stamped (nothing exists yet)", async () => {
    h.create.mockImplementation(
      async () =>
        ({
          status: "proposed",
          id: null,
          proposalId: "p1",
        }) as never
    );
    await applyPackagePostWorkspace({
      workspaceId: WS,
      userId: USER,
      body: { automations: [AUTO], _meta: { slug: "acme/crm-pack" } },
    });
    expect(h.stamp).not.toHaveBeenCalled();
  });
});
