/**
 * applyPackagePostWorkspace stamps every automation it installs with the
 * package that installed it (`metadata.installedByPackage` = `_meta.slug`),
 * over anything the author wrote — the stamp `assertNoNamedClash` exempts,
 * so a pack can re-install over its own automations on its base space. An
 * existing row keeps the package that first installed it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  create: vi.fn(async (_input: unknown) => ({ status: "created", id: "a1" })),
  update: vi.fn(async (_input: unknown) => ({ status: "updated" })),
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
  h.existingAutomation = [];
});

describe("automations carry the package that installed them", () => {
  it("stamps a created automation with _meta.slug, over the author's own value", async () => {
    await applyPackagePostWorkspace({
      workspaceId: WS,
      userId: USER,
      body: { automations: [AUTO], _meta: { slug: "acme/crm-pack" } },
    });
    expect(metadataOf(h.create)).toEqual({
      kind: "digest",
      templateKey: "crm.digest",
      installedByPackage: "acme/crm-pack",
    });
  });

  it("stamps a reused automation that has no stamp yet", async () => {
    h.existingAutomation = [
      { id: "a9", metadata: { templateKey: "crm.digest" } },
    ];
    await applyPackagePostWorkspace({
      workspaceId: WS,
      userId: USER,
      body: { automations: [AUTO], _meta: { slug: "acme/crm-pack" } },
    });
    expect(metadataOf(h.update)).toMatchObject({
      templateKey: "crm.digest",
      installedByPackage: "acme/crm-pack",
    });
  });

  it("keeps the package that first installed an existing automation", async () => {
    h.existingAutomation = [
      { id: "a9", metadata: { installedByPackage: "crm" } },
    ];
    await applyPackagePostWorkspace({
      workspaceId: WS,
      userId: USER,
      body: { automations: [AUTO], _meta: { slug: "acme/crm-pack" } },
    });
    expect(metadataOf(h.update)?.installedByPackage).toBe("crm");
  });

  it("stamps nothing for a definition with no package identity", async () => {
    await applyPackagePostWorkspace({
      workspaceId: WS,
      userId: USER,
      body: { automations: [{ ...AUTO, metadata: undefined }] },
    });
    expect(metadataOf(h.create)).toEqual({ templateKey: "crm.digest" });
  });
});
