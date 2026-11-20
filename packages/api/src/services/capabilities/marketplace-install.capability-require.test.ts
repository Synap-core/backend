/**
 * A capability installs what it `require`s first (finding f40e7783).
 *
 * A capability package declares `dependencies` like any package
 * (`{capability, dependencies:[{kind:"capability", slug}]}`). The capability
 * door used to apply the definition alone, so an add-on such as
 * `apify-linkedin-profiles` installed on a pod without Apify and failed at run
 * time ("Tool not found for name: apify_api"). Now every capability install
 * door (`applyCapabilityDefinition`) resolves the package's dependencies
 * through the one resolver before the capability, and refuses, with nothing of
 * the capability written, when a required capability cannot be installed.
 *
 * Driven through the REAL `applyMarketInstall` → REAL `applyCapabilityDefinition`
 * → REAL `resolvePackageDependencies`; only the governed applier and the
 * template load are stubbed, so the assertion is on what reaches the applier
 * and in which order.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { createCapabilityMock, loadTemplateMock } = vi.hoisted(() => ({
  createCapabilityMock: vi.fn(
    async (def: { key?: string }, _params: unknown, _ctx: unknown) => ({
      capabilityKey: def.key ?? "(none)",
      created: { tools: [] },
    })
  ),
  loadTemplateMock: vi.fn(async (_key: string): Promise<unknown> => null),
}));

vi.mock("./create-from-definition.js", () => ({
  createCapabilityFromDefinition: createCapabilityMock,
  loadCapabilityTemplate: loadTemplateMock,
}));
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(async () => null),
}));
vi.mock("../../routers/hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: vi.fn(async (userId: string) => ({
    userId,
    authenticated: true,
  })),
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getWorkspaceMembership: vi.fn(async () => ({ role: "owner" })),
  };
});

import { applyMarketInstall } from "./marketplace-install.js";

const APIFY = {
  key: "apify",
  name: "Apify",
  tools: [{ name: "apify_api", kind: "http", credentialRef: "vault://apify" }],
  skills: [],
};
const ADDON = {
  key: "apify-linkedin-profiles",
  name: "LinkedIn profiles",
  extends: "apify",
  tools: [],
  skills: [{ name: "linkedin-profile", requires: ["apify_api"] }],
};
const wire = (dependencies: unknown[]) => ({
  profiles: [],
  capability: ADDON,
  dependencies,
  _meta: { slug: ADDON.key },
});
const install = (definition: Record<string, unknown>) =>
  applyMarketInstall({
    kind: "capability",
    slug: ADDON.key,
    definition,
    userId: "user-1",
    workspaceId: "ws-1",
  });

describe("applyMarketInstall — a capability's require dependencies", () => {
  beforeEach(() => {
    createCapabilityMock.mockClear();
    loadTemplateMock.mockReset();
  });

  it("installs the required capability before the capability itself", async () => {
    loadTemplateMock.mockResolvedValue(APIFY);
    const result = await install(
      wire([{ kind: "capability", slug: "apify", relation: "require" }])
    );

    expect(loadTemplateMock).toHaveBeenCalledWith("apify");
    expect(createCapabilityMock.mock.calls.map((c) => c[0].key)).toEqual([
      "apify",
      ADDON.key,
    ]);
    expect(result.dependencies).toEqual([
      expect.objectContaining({
        slug: "apify",
        kind: "capability",
        action: "installed",
      }),
    ]);
  });

  it("refuses, writing nothing of the capability, when a required capability cannot be installed", async () => {
    loadTemplateMock.mockRejectedValue(new Error("not in the catalog"));
    await expect(
      install(wire([{ kind: "capability", slug: "apify" }]))
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining('requires "apify"'),
    });
    expect(createCapabilityMock).not.toHaveBeenCalled();
  });

  it("refuses a compose dependency: a capability is no overlay", async () => {
    await expect(
      install(wire([{ kind: "workspace", slug: "crm", relation: "compose" }]))
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(createCapabilityMock).not.toHaveBeenCalled();
  });

  it("a capability with no dependencies resolves none", async () => {
    const result = await install({ capability: APIFY });
    expect(loadTemplateMock).not.toHaveBeenCalled();
    expect(createCapabilityMock).toHaveBeenCalledTimes(1);
    expect(result.dependencies).toEqual([]);
  });
});
