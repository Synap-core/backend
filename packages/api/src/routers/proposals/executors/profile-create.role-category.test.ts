/**
 * An agent's ROLE proposal keeps its `roleCategory` through approval.
 *
 * Before: `profiles.create` built the proposal's gate `data` without
 * `roleCategory`, and the `profile/create` approve-executor never forwarded it —
 * so an approved agent-defined role materialized with NO category, and
 * `entity.query { roleCategory }` could never match it. The direct (human) path
 * always persisted it; only the governed path lost it.
 *
 * Drives the REAL `profiles.create` as the agent (records the gate data it
 * files) → the proposal row in the nested shape `checkPermissionOrPropose`
 * stores (`proposal.data.data`) → the REAL `profile/create` executor → the REAL
 * `profiles.create` re-run as the approver → the row handed to
 * `ProfileRepository.create`. Replaced: the DB, the audit log, the gate
 * (agent → proposal, approver → grant), and the repository, which records.
 * The nesting step is hand-built from the documented shape — that seam is
 * `permission-check.ts`'s, not covered here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const WS = "33333333-3333-4333-8333-333333333333";
const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  gateData: [] as Array<Record<string, unknown>>,
  created: [] as Array<Record<string, unknown>>,
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
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };
  class FakeProfileRepository {
    async getBySlug() {
      return null;
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

const { profilesRouter } = await import("../../profiles.js");
const { registerProfileExecutors } = await import("./profile.js");
const { proposalExecRegistry } = await import("../execution-registry.js");

beforeEach(() => {
  h.gateData.length = 0;
  h.created.length = 0;
  proposalExecRegistry._reset();
  registerProfileExecutors();
});

describe("profile/create — an agent role proposal keeps roleCategory through approval", () => {
  it("the approved role row carries the category, kind and applicable kinds the agent proposed", async () => {
    const agentCaller = profilesRouter.createCaller({
      authenticated: true,
      userId: OWNER,
      workspaceId: WS,
    } as never);
    const proposed = await agentCaller.create({
      slug: "sponsor",
      displayName: "Sponsor",
      profileKind: "role",
      applicableKinds: ["company"],
      roleCategory: "commercial",
      entityScope: "workspace",
      uiHints: { icon: "handshake" },
      agentUserId: AGENT,
    });
    expect(proposed).toMatchObject({ status: "proposed" });
    // Nothing was written on the propose path.
    expect(h.created).toEqual([]);
    expect(h.gateData).toHaveLength(1);

    const executor = proposalExecRegistry.resolve("profile/create", "create");
    if (!executor) throw new Error("profile/create executor not registered");
    await executor.execute({
      proposal: {
        workspaceId: WS,
        agentUserId: AGENT,
        data: { data: h.gateData[0] },
      },
      userId: OWNER,
      input: { proposalId: "prop-role" },
      deps: { emitProposalReviewed: vi.fn() },
    } as never);

    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      slug: "sponsor",
      profileKind: "role",
      applicableKinds: ["company"],
      roleCategory: "commercial",
      entityScope: "workspace",
      uiHints: { icon: "handshake" },
      origin: "agent",
    });
  });
});
