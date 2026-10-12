/**
 * applyPackagePostWorkspace — an item whose governed write only FILED a
 * proposal reports `proposed`, never `created`/`updated`.
 *
 * Why it matters: the template approve path stamps the new package version
 * only when `postWorkspaceLayersConverged(bag)` holds — no error, nothing
 * `proposed`. A capability, loop or automation that came back "created" while
 * its write was still waiting for review let the stamp claim a layer that had
 * not landed, so the next `market update` called the space current.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  capResult: {} as Record<string, unknown>,
  loopResult: {} as Record<string, unknown>,
  autoCreate: {} as Record<string, unknown>,
  autoUpdate: {} as Record<string, unknown>,
  existingAutomation: [] as Array<{ id: string; metadata: unknown }>,
}));

vi.mock("./capabilities/create-from-definition.js", () => ({
  createCapabilityFromDefinition: vi.fn(async () => h.capResult),
  loadCapabilityTemplate: vi.fn(async () => undefined),
}));
vi.mock("./loops/create-from-definition.js", () => ({
  createLoopFromDefinition: vi.fn(async () => h.loopResult),
}));
vi.mock("../routers/automations.js", () => ({
  automationsRouter: {
    createCaller: () => ({
      create: vi.fn(async () => h.autoCreate),
      update: vi.fn(async () => h.autoUpdate),
    }),
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
import { postWorkspaceLayersConverged } from "./capabilities/install-layers.js";

const WS = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const AUTO = {
  name: "Nightly digest",
  triggerType: "manual" as const,
  triggerConfig: {},
};

beforeEach(() => {
  h.capResult = { capabilityKey: "docs", created: true, proposals: [] };
  h.loopResult = { loopKey: "weekly", created: true, proposals: [] };
  h.autoCreate = { status: "created", id: "a1" };
  h.autoUpdate = { status: "updated" };
  h.existingAutomation = [];
});

describe("a layer item that only filed a proposal reports `proposed`", () => {
  it("capability with a pending proposal → proposed, and layer 2 has NOT converged", async () => {
    h.capResult = { capabilityKey: "docs", created: true, proposals: ["p1"] };
    const bag = await applyPackagePostWorkspace({
      workspaceId: WS,
      userId: USER,
      body: { capabilities: [{ definition: { key: "docs" } }] },
    });
    expect(bag.capabilities).toEqual([
      { key: "docs", status: "proposed", created: true, proposals: ["p1"] },
    ]);
    expect(postWorkspaceLayersConverged(bag)).toBe(false);
  });

  it("capability with no proposal → created, converged", async () => {
    const bag = await applyPackagePostWorkspace({
      workspaceId: WS,
      userId: USER,
      body: { capabilities: [{ definition: { key: "docs" } }] },
    });
    expect(bag.capabilities).toEqual([
      { key: "docs", status: "created", created: true },
    ]);
    expect(postWorkspaceLayersConverged(bag)).toBe(true);
  });

  it("loop with a pending proposal → proposed", async () => {
    h.loopResult = { loopKey: "weekly", created: true, proposals: ["p2"] };
    const bag = await applyPackagePostWorkspace({
      workspaceId: WS,
      userId: USER,
      body: { loops: [{ definition: { key: "weekly" } }] },
    });
    expect(bag.loops).toEqual([
      { key: "weekly", status: "proposed", created: true, proposals: ["p2"] },
    ]);
    expect(postWorkspaceLayersConverged(bag)).toBe(false);
  });

  it("automation create that proposed → proposed", async () => {
    h.autoCreate = { status: "proposed", id: null, proposalId: "p3" };
    const bag = await applyPackagePostWorkspace({
      workspaceId: WS,
      userId: USER,
      body: { automations: [AUTO] },
    });
    expect(bag.automations).toEqual([
      { name: AUTO.name, status: "proposed", proposalId: "p3" },
    ]);
    expect(postWorkspaceLayersConverged(bag)).toBe(false);
  });

  it("automation update of an existing row that proposed → proposed, not 'updated'", async () => {
    h.existingAutomation = [{ id: "a9", metadata: null }];
    h.autoUpdate = { status: "proposed", proposalId: "p4" };
    const bag = await applyPackagePostWorkspace({
      workspaceId: WS,
      userId: USER,
      body: { automations: [AUTO] },
    });
    expect(bag.automations).toEqual([
      { name: AUTO.name, status: "proposed", id: "a9", proposalId: "p4" },
    ]);
    expect(postWorkspaceLayersConverged(bag)).toBe(false);
  });
});
