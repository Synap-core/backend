/**
 * An approved AGENT kind proposal re-runs the cross-workspace twin check —
 * unless the reviewer was SHOWN the twin (the duplicate door's answer rides the
 * proposal, FB1020 B2): then approving IS the reviewer's "keep both".
 *
 * Ticket 5c3879d4: the pod holds Research's `finding` (a validated fact) and
 * Builder's `finding` (a product problem). Builder's was minted by a replayed
 * agent `profile/create` proposal that a human approved: the executor re-enters
 * `profiles.create` as the APPROVER (no agentUserId, no acting-agent ALS), and
 * the twin refusal was AI-callers-only — so it was skipped on exactly that path.
 *
 * Drives the REAL `profile/create` executor → the REAL `profiles.create` re-run
 * as the approver → the repository, which records. Replaced: the DB, the audit
 * log, the gate (agent → proposal, approver → grant), and the repository. The
 * replayed proposal row is hand-built in the nested shape
 * `checkPermissionOrPropose` stores (`proposal.data.data`) — a replay never
 * went through the propose door, which is the point.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const WS_BUILDER = "33333333-3333-4333-8333-333333333333";
const WS_RESEARCH = "44444444-4444-4444-8444-444444444444";
const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  gateData: [] as Array<Record<string, unknown>>,
  gateDuplicateChecks: [] as unknown[],
  created: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const fakeDb = {
    query: {
      workspaceMembers: { findFirst: vi.fn(async () => ({ role: "owner" })) },
      workspaces: { findFirst: vi.fn(async () => ({ archivedAt: null })) },
    },
    select: () => ({ from: () => ({ where: async () => [] }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };
  class FakeProfileRepository {
    // Not visible from Builder's lens, and no pod-wide row holds the slug…
    async getBySlug() {
      return null;
    }
    async findActivePodWideKind() {
      return null;
    }
    // …but Research's workspace-scoped `finding` exists elsewhere on the pod.
    async findActiveBySlugAnyScope(slug: string) {
      return slug === "finding"
        ? [
            {
              id: "bc633e0d-32ae-4431-be9f-0363517c3f01",
              slug: "finding",
              displayName: "Finding",
              scope: "workspace",
              workspaceId: WS_RESEARCH,
            },
          ]
        : [];
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
        h.gateDuplicateChecks.push(opts.duplicateCheck);
        return { proposalId: "prop-kind", proposalType: "profile.create" };
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
  h.gateDuplicateChecks.length = 0;
  h.created.length = 0;
  proposalExecRegistry._reset();
  registerProfileExecutors();
});

function approve(
  innerData: Record<string, unknown>,
  envelope: Record<string, unknown> = {}
) {
  const executor = proposalExecRegistry.resolve("profile/create", "create");
  if (!executor) throw new Error("profile/create executor not registered");
  return executor.execute({
    proposal: {
      workspaceId: WS_BUILDER,
      agentUserId: AGENT,
      data: { ...envelope, data: innerData },
    },
    userId: OWNER,
    input: { proposalId: "prop-kind" },
    deps: { emitProposalReviewed: vi.fn() },
  } as never);
}

describe("profile/create — an approved agent kind proposal cannot mint a cross-workspace twin", () => {
  it("the replayed `finding` proposal is refused at approve, naming the existing kind", async () => {
    const err = await approve({
      id: "7e94b813-3609-4920-a937-5d33e84220df",
      slug: "finding",
      scope: "workspace",
      displayName: "Finding",
      entityScope: "pod",
      profileKind: "kind",
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CONFLICT" });
    expect(String((err as Error).message)).toContain(
      "bc633e0d-32ae-4431-be9f-0363517c3f01"
    );
    expect(h.created).toEqual([]);
  });

  it("a twin the reviewer was SHOWN is created on approval (keep both)", async () => {
    const agentCaller = profilesRouter.createCaller({
      authenticated: true,
      userId: OWNER,
      workspaceId: WS_BUILDER,
    } as never);
    const proposed = await agentCaller.create({
      slug: "finding",
      displayName: "Finding",
      entityScope: "pod",
      agentUserId: AGENT,
    });
    expect(proposed).toMatchObject({ status: "proposed" });
    // The filing carried the existing kind to the card…
    expect(h.gateDuplicateChecks[0]).toMatchObject({
      status: "possible",
      candidates: [{ id: "bc633e0d-32ae-4431-be9f-0363517c3f01" }],
    });

    // …so the replay of THAT proposal (envelope as stored) stands down.
    await approve(h.gateData[0]!, {
      duplicateCheck: h.gateDuplicateChecks[0],
    });
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ slug: "finding", origin: "agent" });
  });

  it("a human's direct create is unchanged (deliberate multi-tenancy is not second-guessed)", async () => {
    const humanCaller = profilesRouter.createCaller({
      authenticated: true,
      userId: OWNER,
      workspaceId: WS_BUILDER,
    } as never);
    await humanCaller.create({ slug: "finding", displayName: "Finding" });
    expect(h.created).toHaveLength(1);
  });
});
