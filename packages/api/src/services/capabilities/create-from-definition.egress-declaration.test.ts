/**
 * A package's DECLARED skill egress must reach the PERSISTED row.
 *
 * `run-skill-in-sandbox.ts` reads `skill.metadata?.allowedHosts ?? []` and
 * `host.fetch` refuses every hostname not on it. That gate is real and
 * default-deny — but until this wave it had NO writer reachable from a package:
 * the applier's `skillsCaller.create({...})` passed no `metadata` at all, so a
 * third-party skill calling its own vendor's API installed cleanly and died at
 * run with `domain_not_approved`. A functionality blocker, not a posture one.
 *
 * These tests deliberately assert the PERSISTED VALUE — the object handed to
 * Drizzle's `.values()` / `.set()` — and NOT that a helper was called. The prior
 * test at this seam covered the helper and passed with the fix removed; here the
 * real `skillsRouter` caller runs between the applier and the write, so removing
 * the applier's `metadata:` line makes these fail.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  insertedRows,
  updatedSets,
  existingSkillRow,
  mockCheckPermissionOrPropose,
} = vi.hoisted(() => ({
  insertedRows: [] as Record<string, unknown>[],
  updatedSets: [] as Record<string, unknown>[],
  existingSkillRow: { current: null as Record<string, unknown> | null },
  mockCheckPermissionOrPropose: vi.fn(),
}));

vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: mockCheckPermissionOrPropose,
  createPendingProposal: vi.fn(),
}));
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(async () => null),
}));
vi.mock("../links/links-service.js", () => ({
  createLinks: vi.fn(async () => []),
  getLinksFor: vi.fn(async () => []),
  deleteLink: vi.fn(async () => undefined),
}));
vi.mock("../../routers/capability-containers.js", () => ({
  capabilityContainersRouter: {
    createCaller: () => ({
      create: vi.fn(async () => ({ capability: { id: "cap-1" } })),
      addPart: vi.fn(async () => ({ ok: true })),
    }),
  },
}));
// The pod split-brain read-only guard runs in the tRPC middleware chain and
// reads a table this stub does not model; the guard is not what is under test.
vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: async () => false,
  getSyncGenerationState: async () => ({ generation: 1, isPrimary: true }),
  invalidateSyncGenerationCache: vi.fn(),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));

// `db` is stubbed at the DATABASE boundary (not at the router boundary) on
// purpose: the REAL `skillsRouter.create` therefore runs between the applier and
// the write, so what lands in `insertedRows` is what the row would actually hold.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    innerJoin: () => selectChain,
    leftJoin: () => selectChain,
    limit: async () =>
      existingSkillRow.current ? [existingSkillRow.current] : [],
    then: (resolve: (rows: unknown[]) => unknown) =>
      resolve(existingSkillRow.current ? [existingSkillRow.current] : []),
  };
  const updateChain = {
    set: (v: Record<string, unknown>) => {
      updatedSets.push(v);
      return updateChain;
    },
    where: async () => undefined,
  };
  return {
    ...actual,
    db: {
      select: () => selectChain,
      update: () => updateChain,
      insert: () => ({
        values: (v: Record<string, unknown>) => ({
          returning: async () => {
            insertedRows.push(v);
            return [{ ...v, id: "skill-1" }];
          },
        }),
      }),
      query: {
        skills: { findFirst: async () => existingSkillRow.current },
      },
    },
  };
});

import { createCapabilityFromDefinition } from "./create-from-definition.js";

const WS = "11111111-1111-1111-1111-111111111111";
const UID = "22222222-2222-2222-2222-222222222222";
const HOSTS = ["api.vendor.com", "cdn.vendor.com"];

const applySkill = (skill: Record<string, unknown>) =>
  createCapabilityFromDefinition(
    {
      key: "test.cap",
      name: "Test Capability",
      vault: [],
      tools: [],
      skills: [skill],
      playbooks: [],
    } as never,
    {},
    { userId: UID, workspaceId: WS, authenticated: true } as never
  );

const SKILL = {
  name: "vendor_fetch",
  kind: "code",
  description: "Call the vendor API",
  code: "return 1;",
  metadata: { allowedHosts: HOSTS },
};

describe("declared skill egress reaches the persisted row", () => {
  beforeEach(() => {
    insertedRows.length = 0;
    updatedSets.length = 0;
    existingSkillRow.current = null;
    mockCheckPermissionOrPropose.mockReset();
    mockCheckPermissionOrPropose.mockResolvedValue({ granted: true });
  });

  it("CREATE: the persisted row carries metadata.allowedHosts", async () => {
    await applySkill(SKILL);
    const row = insertedRows.find((r) => r.name === "vendor_fetch");
    expect(
      row,
      "no skills row was inserted — the test wiring is broken"
    ).toBeTruthy();
    expect(
      (row!.metadata as Record<string, unknown> | undefined)?.allowedHosts,
      "the declared egress allowlist did not reach the persisted skills row — " +
        "the sandbox is default-deny, so this skill can reach NO host at run time"
    ).toEqual(HOSTS);
  });

  it("CREATE: a skill declaring no hosts persists no allowlist (no accidental grant)", async () => {
    await applySkill({ ...SKILL, metadata: {} });
    const row = insertedRows.find((r) => r.name === "vendor_fetch");
    expect(
      (row?.metadata as Record<string, unknown> | undefined)?.allowedHosts
    ).toBeUndefined();
  });

  it("UPDATE: a declared allowlist is MERGED onto the live bag, DB-owned keys intact", async () => {
    existingSkillRow.current = {
      id: "skill-1",
      name: "vendor_fetch",
      kind: "code",
      code: "return 1;",
      providerSpec: null,
      parameters: {},
      description: "Call the vendor API",
      scope: "pod",
      category: null,
      agentTypes: null,
      executionMode: "sync",
      timeoutSeconds: 30,
      body: null,
      approved: true,
      metadata: {
        marketSource: { slug: "vendor-pack" },
        allowedHosts: ["old.example.com"],
      },
    };

    await applySkill(SKILL);

    const set = updatedSets.find((s) => s.name === undefined && s.metadata);
    expect(set, "the applier's skills UPDATE never ran").toBeTruthy();
    expect(set!.metadata).toEqual({
      marketSource: { slug: "vendor-pack" },
      allowedHosts: HOSTS,
    });
    expect(
      set!.approved,
      "widening an APPROVED skill's egress allowlist must demote it — that is " +
        "the one rule both write doors share (`allowedHostsChanged`)"
    ).toBe(false);
  });

  it("UPDATE: replaying the SAME allowlist does not demote (change, not presence)", async () => {
    existingSkillRow.current = {
      id: "skill-1",
      name: "vendor_fetch",
      kind: "code",
      code: "return 1;",
      providerSpec: null,
      parameters: {},
      description: "Call the vendor API",
      scope: "pod",
      category: null,
      agentTypes: null,
      executionMode: "sync",
      timeoutSeconds: 30,
      body: null,
      approved: true,
      metadata: { allowedHosts: [...HOSTS] },
    };

    await applySkill(SKILL);

    const set = updatedSets.find((s) => s.metadata);
    expect(set!.metadata).toEqual({ allowedHosts: HOSTS });
    expect(
      "approved" in set!,
      "an unchanged allowlist must not demote — a reconcile that replays the " +
        "install baseline every boot would otherwise silently un-approve the skill"
    ).toBe(false);
  });
});
