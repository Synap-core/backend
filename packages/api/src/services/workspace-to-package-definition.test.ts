/**
 * workspaceToPackageDefinition — the extraction door round-trips the FULL
 * definition, not the lossy profiles-only subset the frontend hook emits.
 *
 * This case locks the load-bearing requirement of the pod-native extraction
 * door: a live workspace's AUTOMATIONS and PLAYBOOKS (with their grants) are
 * captured into the emitted `PackageDefinition` — the exact layers
 * `useExportWorkspaceAsPackage` drops.
 *
 * Heavy I/O (`db`, repositories, `ProfileResolutionService`) is mocked — the
 * assertion is on the SERIALIZATION mapping, not on a live pod.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { sentinel, rowsByTable, workspaceRow } = vi.hoisted(() => ({
  sentinel: {
    workspaces: { id: "id" },
    views: {},
    automations: {},
    playbooks: {},
    capabilities: {},
    entityTemplates: {},
    links: { fromType: "f", linkType: "lt", fromId: "fid" },
    tools: {},
    skills: {},
  },
  rowsByTable: new Map<unknown, unknown[]>(),
  workspaceRow: {
    ref: { current: null as Record<string, unknown> | null },
  },
}));

vi.mock("@synap/database", () => {
  const chainFor = () => {
    let tbl: unknown;
    const chain = {
      from: (t: unknown) => {
        tbl = t;
        return chain;
      },
      where: () => rowsByTable.get(tbl) ?? [],
    };
    return chain;
  };
  return {
    getDb: async () => ({
      query: {
        workspaces: { findFirst: async () => workspaceRow.ref.current },
        views: { findMany: async () => [] },
      },
    }),
    db: { select: () => chainFor() },
    and: (...a: unknown[]) => a,
    eq: (...a: unknown[]) => a,
    inArray: (...a: unknown[]) => a,
    ProfileRepository: class {
      async getAccessibleProfiles() {
        return [];
      }
    },
    ProfileResolutionService: class {
      async getEffectiveProperties() {
        return [];
      }
    },
    ProfileScope: {
      SYSTEM: "system",
      SHARED: "shared",
      WORKSPACE: "workspace",
      USER: "user",
    },
    RelationDefRepository: class {
      async list() {
        return [];
      }
    },
    ProfileRelationRepository: class {
      async listForProfiles() {
        return [];
      }
    },
    views: sentinel.views,
    automations: sentinel.automations,
    playbooks: sentinel.playbooks,
    capabilities: sentinel.capabilities,
    entityTemplates: sentinel.entityTemplates,
    links: sentinel.links,
    tools: sentinel.tools,
    skills: sentinel.skills,
    workspaces: sentinel.workspaces,
  };
});

import { workspaceToPackageDefinition } from "./workspace-to-package-definition.js";

describe("workspaceToPackageDefinition — captures automations + playbooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rowsByTable.clear();

    workspaceRow.ref.current = {
      id: "ws-1",
      name: "My Ops Workspace",
      description: "hand-built",
      settings: { workspaceSubtype: "operations", packageSlug: "ops-x" },
    };

    rowsByTable.set(sentinel.automations, [
      {
        name: "Nightly digest",
        description: "runs nightly",
        triggerType: "cron",
        triggerConfig: { cron: "0 2 * * *" },
        flowDefinition: { nodes: [{ id: "n1" }], edges: [] },
        status: "active",
      },
    ]);
    rowsByTable.set(sentinel.playbooks, [
      {
        id: "pb-1",
        name: "Onboard client",
        description: "guided onboarding",
        goalTemplate: "Onboard {{client}}",
        params: [],
        executor: "is-agent",
        inputStrategy: { kind: "none" },
        channelSpec: {},
        schedule: null,
        subjectProfile: { profileSlug: "client" },
        status: "active",
      },
    ]);
    // Grant edges + capabilities + display templates: none for this case.
    rowsByTable.set(sentinel.links, []);
    rowsByTable.set(sentinel.capabilities, []);
    rowsByTable.set(sentinel.entityTemplates, []);
  });

  it("round-trips automations + playbooks into the PackageDefinition", async () => {
    const def = await workspaceToPackageDefinition({
      workspaceId: "ws-1",
      userId: "user-1",
    });

    // Provenance + workspace-level fields.
    expect(def.workspaceName).toBe("My Ops Workspace");
    expect(def.workspaceSubtype).toBe("operations");
    expect(def._meta?.slug).toBe("ops-x");

    // The layers the frontend export DROPS are present here.
    expect(def.automations).toHaveLength(1);
    expect(def.automations?.[0]).toMatchObject({
      name: "Nightly digest",
      trigger: { type: "cron", cron: "0 2 * * *" },
    });
    expect(def.automations?.[0].flow?.nodes).toHaveLength(1);

    expect(def.playbooks).toHaveLength(1);
    expect(def.playbooks?.[0]).toMatchObject({
      name: "Onboard client",
      goalTemplate: "Onboard {{client}}",
      subjectProfile: { profileSlug: "client" },
      inputStrategy: "none",
    });
  });
});
