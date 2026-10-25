/**
 * A NEW kind's fields ride its own proposal (ticket a375443d).
 *
 * Before: an agent's define_kind filed the kind and DEFERRED every field
 * ("re-call once approved"); the re-call then filed one proposal PER field —
 * 16 of them, and the last 3 refused at the agent's proposal limit.
 *
 * Drives the REAL `profiles.create` as the agent (records the gate data) →
 * the proposal row in the nested `proposal.data.data` shape → the REAL
 * `profile/create` executor as the approver. Replaced: the DB, the audit log,
 * the gate, the repository and the field write (`createAndLinkPropertyDef`,
 * whose own suites cover it), each recording.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const WS = "33333333-3333-4333-8333-333333333333";
const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  gateData: [] as Array<Record<string, unknown>>,
  created: [] as Array<Record<string, unknown>>,
  fields: [] as Array<Record<string, unknown>>,
  failSlug: null as string | null,
  sets: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const fakeDb = {
    query: {
      workspaceMembers: { findFirst: vi.fn(async () => ({ role: "owner" })) },
      workspaces: { findFirst: vi.fn(async () => ({ archivedAt: null })) },
    },
    // Executor idempotency probe: "already APPROVED?" → no rows.
    select: () => ({ from: () => ({ where: async () => [] }) }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        h.sets.push(v);
        return { where: async () => undefined };
      },
    }),
  };
  class FakeProfileRepository {
    async getBySlug() {
      return null;
    }
    // A KIND (not a role) also probes the pod-wide kind of that slug.
    async findActivePodWideKind() {
      return null;
    }
    // The lookups resolveProfileForApply makes before it creates — none find
    // a row, so the proposal's role is created fresh.
    async getBySlugForWorkspace() {
      return null;
    }
    async findActiveBySlugAnyScope() {
      return [];
    }
    async findPodWideBySlugIncludingInactive() {
      return [];
    }
    async findWorkspaceScopedBySlugIncludingInactive() {
      return [];
    }
    async create(input: Record<string, unknown>) {
      h.created.push(input);
      return { ...input };
    }
    async grantAccess() {}
  }
  return {
    ...actual,
    db: fakeDb,
    getDb: vi.fn(async () => fakeDb),
    ProfileRepository: FakeProfileRepository,
    getWorkspaceMembership: vi.fn(async () => ({ role: "owner" })),
  };
});

vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: "evt-1" })),
}));

vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: vi.fn(async (opts: Record<string, unknown>) => {
      if (opts.agentUserId) {
        h.gateData.push(opts.data as Record<string, unknown>);
        return { proposalId: "prop-role", proposalType: "profile.create" };
      }
      return { granted: true };
    }),
  };
});

vi.mock("./shared.js", () => ({ reportApproved: vi.fn() }));

// The duplicate door reads other kinds: none here.
vi.mock("../../../services/duplicates/find-duplicate-candidates.js", () => ({
  findDuplicateCandidates: vi.fn(async () => ({ check: undefined })),
}));

// The field write is the seam's far end: record what the executor asks for.
vi.mock("../../../services/profiles/create-and-link-property-def.js", () => ({
  createAndLinkPropertyDef: vi.fn(async (input: Record<string, unknown>) => {
    if (input.slug === h.failSlug) throw new Error("slug conflict");
    h.fields.push(input);
    return { propertyDef: { id: `def-${String(input.slug)}` } };
  }),
}));

const { profilesRouter } = await import("../../profiles.js");
const { registerProfileExecutors } = await import("./profile.js");
const { proposalExecRegistry } = await import("../execution-registry.js");

beforeEach(() => {
  h.gateData.length = 0;
  h.created.length = 0;
  h.fields.length = 0;
  h.failSlug = null;
  h.sets.length = 0;
  proposalExecRegistry._reset();
  registerProfileExecutors();
});

const proposeKind = async () => {
  const agentCaller = profilesRouter.createCaller({
    authenticated: true,
    userId: OWNER,
    workspaceId: WS,
  } as never);
  return agentCaller.create({
    slug: "social-account-audit",
    displayName: "Social account audit",
    agentUserId: AGENT,
    deferredFields: [
      { slug: "botscore", valueType: "number" },
      {
        slug: "handle",
        valueType: "string",
        required: true,
        uiHints: { displayName: "Handle" },
      },
    ],
  });
};

const approve = async (gateData = h.gateData[0]) => {
  const executor = proposalExecRegistry.resolve("profile/create", "create");
  if (!executor) throw new Error("profile/create executor not registered");
  return executor.execute({
    proposal: {
      workspaceId: WS,
      agentUserId: AGENT,
      data: { data: gateData },
    },
    userId: OWNER,
    input: { proposalId: "prop-role" },
    deps: { emitProposalReviewed: vi.fn() },
  } as never);
};

describe("profile/create — a new kind's fields ride its proposal", () => {
  it("files ONE proposal carrying the fields, and approving it creates the kind and every field", async () => {
    const proposed = await proposeKind();
    expect(proposed).toMatchObject({ status: "proposed", fieldsIncluded: 2 });
    expect(h.gateData).toHaveLength(1);
    expect(h.gateData[0]!.fields).toEqual([
      { slug: "botscore", valueType: "number" },
      {
        slug: "handle",
        valueType: "string",
        required: true,
        uiHints: { displayName: "Handle" },
      },
    ]);
    // Nothing is written before review.
    expect(h.created).toEqual([]);
    expect(h.fields).toEqual([]);

    await approve();
    expect(h.created).toHaveLength(1);
    const kindId = h.created[0]!.id;
    expect(h.fields.map((f) => [f.slug, f.profileId, f.userId])).toEqual([
      ["botscore", kindId, OWNER],
      ["handle", kindId, OWNER],
    ]);
    expect(h.fields[1]).toMatchObject({
      valueType: "string",
      required: true,
      uiHints: { displayName: "Handle" },
      workspaceId: WS,
    });
  });

  it("one field that fails never undoes the kind or its siblings, and is REPORTED", async () => {
    await proposeKind();
    h.failSlug = "botscore";
    const result = await approve();
    expect(h.created).toHaveLength(1);
    expect(h.fields.map((f) => f.slug)).toEqual(["handle"]);
    expect(result.refusals).toEqual([
      'Field "botscore" was not created: slug conflict',
    ]);
    const approvedRow = h.sets.find((v) => v.status === "approved");
    expect(
      (approvedRow?.data as { fieldOutcomes?: unknown }).fieldOutcomes
    ).toEqual([
      { slug: "botscore", outcome: "refused", reason: "slug conflict" },
      { slug: "handle", outcome: "created" },
    ]);
  });

  it("re-checks every stored field at approval: one that no longer parses is refused, never written", async () => {
    await proposeKind();
    const stored = {
      ...h.gateData[0],
      fields: [
        ...(h.gateData[0]!.fields as unknown[]),
        { slug: "Bad Slug", valueType: "string" },
        { slug: "score", valueType: "nope" },
      ],
    };
    const result = await approve(stored);
    expect(h.fields.map((f) => f.slug)).toEqual(["botscore", "handle"]);
    expect(result.refusals).toHaveLength(2);
    expect(result.refusals!.join(" ")).toContain('"Bad Slug"');
    expect(result.refusals!.join(" ")).toContain("valueType must be one of");
  });

  it("a kind proposed without fields carries none", async () => {
    const agentCaller = profilesRouter.createCaller({
      authenticated: true,
      userId: OWNER,
      workspaceId: WS,
    } as never);
    const proposed = await agentCaller.create({
      slug: "plain-kind",
      displayName: "Plain",
      agentUserId: AGENT,
    });
    expect(proposed).not.toHaveProperty("fieldsIncluded");
    expect(h.gateData[0]).not.toHaveProperty("fields");
  });
});
