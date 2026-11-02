/**
 * A BOX skill (`executionMode: "box"`, `metadata.box`) published through a
 * capability definition must be judged by the same rule the skill doors apply,
 * and its declaration must reach the persisted row.
 *
 * Before, the definition type allowed only `sync | async`, the applier dropped
 * `metadata.box`, and its re-apply branch (a direct `UPDATE`) stored whatever
 * the template said. Like the egress test beside it, these assert the PERSISTED
 * VALUE handed to Drizzle, with the real `skillsRouter` between the applier and
 * the write.
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
vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: async () => false,
  getSyncGenerationState: async () => ({ generation: 1, isPrimary: true }),
  invalidateSyncGenerationCache: vi.fn(),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));

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

const BOX = {
  language: "python",
  packages: [{ name: "pandas", version: "2.2.3" }],
  hosts: ["API.example.com"],
};
// What the skill doors store: the declaration normalised.
const BOX_STORED = {
  language: "python",
  entrypoint: "main.py",
  packages: [{ name: "pandas", version: "2.2.3" }],
  hosts: ["api.example.com"],
  limits: {
    wallSeconds: 900,
    cpus: 2,
    memoryMb: 2048,
    diskMb: 8192,
    outMb: 200,
  },
};
// Python source: the isolate's JavaScript globals scan must never see it.
const PY = "import pandas as pd\nprint(pd.__version__)\n";

const SKILL = {
  name: "crunch",
  kind: "code",
  description: "Crunch a csv",
  code: PY,
  executionMode: "box",
  metadata: { box: BOX },
};

const installed = (over: Record<string, unknown> = {}) => ({
  id: "skill-1",
  name: "crunch",
  kind: "code",
  code: PY,
  providerSpec: null,
  parameters: {},
  description: "Crunch a csv",
  scope: "pod",
  category: null,
  agentTypes: null,
  executionMode: "sync",
  timeoutSeconds: 30,
  body: null,
  approved: true,
  metadata: { marketSource: { slug: "vendor-pack" } },
  ...over,
});

describe("a box skill in a capability definition", () => {
  beforeEach(() => {
    insertedRows.length = 0;
    updatedSets.length = 0;
    existingSkillRow.current = null;
    mockCheckPermissionOrPropose.mockReset();
    mockCheckPermissionOrPropose.mockResolvedValue({ granted: true });
  });

  it("CREATE: the row is box mode and carries the normalised declaration", async () => {
    await applySkill(SKILL);
    const row = insertedRows.find((r) => r.name === "crunch");
    expect(row, "no skills row was inserted").toBeTruthy();
    expect(row!.executionMode).toBe("box");
    expect((row!.metadata as Record<string, unknown>).box).toEqual(BOX_STORED);
  });

  it("CREATE: an invalid declaration is refused with the skill door's words, nothing is written", async () => {
    await expect(
      applySkill({
        ...SKILL,
        metadata: {
          box: { ...BOX, packages: [{ name: "pandas", version: ">=2" }] },
        },
      })
    ).rejects.toThrow(
      "box.packages.0.version: an exact version, e.g. 2.2.3 (no ranges)"
    );
    expect(insertedRows).toEqual([]);
  });

  it("UPDATE: an invalid declaration is refused too, the direct update never runs", async () => {
    existingSkillRow.current = installed({ executionMode: "box" });
    await expect(
      applySkill({ ...SKILL, metadata: { box: { language: "ruby" } } })
    ).rejects.toThrow(/^box\.language/);
    expect(updatedSets).toEqual([]);
  });

  it("UPDATE: a box skill with no declaration is refused", async () => {
    existingSkillRow.current = installed();
    await expect(applySkill({ ...SKILL, metadata: {} })).rejects.toThrow(
      /^box/
    );
    expect(updatedSets).toEqual([]);
  });

  it("a box skill that is not code is refused", async () => {
    await expect(applySkill({ ...SKILL, kind: "instruction" })).rejects.toThrow(
      "A box skill is a script: send its code."
    );
    expect(insertedRows).toEqual([]);
  });

  it("a read-only box skill is refused", async () => {
    await expect(
      applySkill({ ...SKILL, metadata: { box: BOX, readOnly: true } })
    ).rejects.toThrow("A box skill cannot be read-only");
    expect(insertedRows).toEqual([]);
  });

  it("UPDATE: a LIVE readOnly: true does not survive a move to box — the bag the row stores is judged, not only the template's", async () => {
    // readOnly set on the live row (edit door, or an older template); the new
    // template moves the skill to box and says nothing about readOnly. The
    // re-apply merges onto the live bag, so storing it would keep readOnly and
    // the gate would auto-run the script once re-approved.
    existingSkillRow.current = installed({
      metadata: { marketSource: { slug: "vendor-pack" }, readOnly: true },
    });
    await expect(applySkill(SKILL)).rejects.toThrow(
      "A box skill cannot be read-only"
    );
    expect(updatedSets).toEqual([]);
  });

  it("UPDATE: a template that moves a read-only skill to box with readOnly: false clears it", async () => {
    existingSkillRow.current = installed({
      metadata: { marketSource: { slug: "vendor-pack" }, readOnly: true },
    });
    await applySkill({ ...SKILL, metadata: { box: BOX, readOnly: false } });
    const set = updatedSets.find((s) => s.metadata);
    expect(set, "the applier's skills UPDATE never ran").toBeTruthy();
    expect(set!.metadata).toEqual({
      marketSource: { slug: "vendor-pack" },
      readOnly: false,
      box: BOX_STORED,
    });
  });

  it("UPDATE: sync -> box stores the declaration, python code passes, and an approved skill is demoted", async () => {
    existingSkillRow.current = installed();
    await applySkill(SKILL);
    const set = updatedSets.find((s) => s.metadata);
    expect(set, "the applier's skills UPDATE never ran").toBeTruthy();
    expect(set!.executionMode).toBe("box");
    expect(set!.metadata).toEqual({
      marketSource: { slug: "vendor-pack" },
      box: BOX_STORED,
    });
    expect(set!.approved).toBe(false);
  });

  it("UPDATE: a changed declaration on an approved box skill demotes it", async () => {
    existingSkillRow.current = installed({
      executionMode: "box",
      metadata: { box: { ...BOX_STORED, hosts: [] } },
    });
    await applySkill(SKILL);
    const set = updatedSets.find((s) => s.metadata);
    expect(set!.approved).toBe(false);
  });

  it("UPDATE: an unchanged declaration keeps the approval (the raw template equals the stored normalised one)", async () => {
    existingSkillRow.current = installed({
      executionMode: "box",
      metadata: { box: BOX_STORED },
    });
    await applySkill(SKILL);
    const set = updatedSets.find((s) => s.metadata);
    expect(set, "the applier's skills UPDATE never ran").toBeTruthy();
    expect(set!.approved).toBeUndefined();
  });
});
