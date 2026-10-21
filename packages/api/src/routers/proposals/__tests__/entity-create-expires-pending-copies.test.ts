/**
 * Approving an entity create expires the agent's other pending copies of the
 * SAME record (live 2026-10-19: a45e9a3a approved → b0588fc6; four identical
 * copies stayed pending against the agent's cap and failed one by one).
 *
 * Drives the real `entity/create` executor (callers mocked, as in
 * `identity-resolution.test.ts`) and records what it hands the ONE expiry door
 * (`expirePendingCreatesOfLandedRecord`, whose SQL + rules are pinned on PGlite
 * in `@synap/database`'s `expire-pending-creates.pglite.test.ts`).
 *
 * Rows that rule out a wrong wiring:
 *  - the door receives the STORED record (with its minted id), not the
 *    reconciled replay input — the copies carry the stored shape;
 *  - it runs AFTER the approval write, so the approved row is no longer
 *    pending when copies are matched;
 *  - it names the landed entity (the RETURNED id, not the minted one) and the
 *    approving proposal;
 *  - a failed create (nothing landed) expires nothing.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

const h = vi.hoisted(() => ({
  create: vi.fn(),
  expire: vi.fn(),
  events: [] as string[],
}));

vi.mock("../../entities.js", () => ({
  mergeSystemData: (a: unknown, b: unknown) => ({
    ...(a as object),
    ...(b as object),
  }),
  entitiesRouter: {
    createCaller: () => ({
      create: h.create,
      update: vi.fn(),
      get: vi.fn(),
      attachFacet: vi.fn(),
    }),
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      update: () => ({
        set: (values: { status?: string }) => ({
          where: async () => {
            h.events.push(`update:${values.status ?? "?"}`);
          },
        }),
      }),
      insert: () => ({
        values: () => ({ onConflictDoNothing: async () => {} }),
      }),
      query: {
        workspaces: { findFirst: async () => null },
        entities: { findFirst: async () => null },
      },
    },
    ProfileResolutionService: class {
      async resolveProfile() {
        return null;
      }
    },
    expirePendingCreatesOfLandedRecord: h.expire,
  };
});
vi.mock(
  "../../../notifications/mark-proposal-notifications-actioned.js",
  () => ({
    markProposalNotificationsActioned: vi.fn(),
  })
);

import { proposalExecRegistry } from "../execution-registry.js";
import { registerEntityExecutors } from "../executors/entity.js";
import type { ProposalExecutorArgs } from "../execution-registry.js";

const MINTED = "00348b58-6798-406d-80ed-50bdc1ba3516";
const LANDED = "b0588fc6-11ce-4752-a619-df40c46f9386";

const stored = {
  id: MINTED,
  profileSlug: "decision",
  title: "Synap messaging: the data layer",
  properties: { summary: "Lead with usefulness.", decisionStatus: "accepted" },
  global: false,
  resolvedWorkspaceId: null,
};

const deps = {
  reportProposalOutcome: vi.fn(),
  emitProposalReviewed: vi.fn(),
  stampProjectMembership: vi.fn(async () => {}),
} as unknown as ProposalExecutorArgs["deps"];

function run() {
  const exec = proposalExecRegistry.resolveExact("entity/create");
  if (!exec) throw new Error("entity/create executor is not registered");
  const data = { requestId: "r-1", changeType: "create", data: stored };
  return exec.execute({
    proposal: {
      id: "p-approved",
      targetType: "entity",
      targetId: MINTED,
      proposalType: "create",
      workspaceId: null,
      sessionId: null,
      projectId: null,
      agentUserId: "agent-1",
      subjectUserId: "owner-1",
      sourceMessageId: null,
      data,
    },
    payload: data as never,
    userId: "approver-1",
    input: { proposalId: "p-approved" },
    ctx: {} as ProposalExecutorArgs["ctx"],
    deps,
  } as unknown as ProposalExecutorArgs);
}

beforeAll(() => {
  registerEntityExecutors();
});

beforeEach(() => {
  h.create.mockReset().mockResolvedValue({ id: LANDED });
  h.expire.mockReset().mockImplementation(async () => {
    h.events.push("expire");
    return ["p-copy"];
  });
  h.events.length = 0;
});

describe("entity/create approval expires the pending copies of the record", () => {
  it("hands the expiry door the stored record, the landed id and the approving proposal", async () => {
    await run();
    expect(h.expire).toHaveBeenCalledTimes(1);
    expect(h.expire.mock.calls[0]![0]).toEqual({
      record: stored,
      entityId: LANDED,
      ownerUserId: "owner-1",
      landedByProposalId: "p-approved",
    });
  });

  it("expires only after the approval write", async () => {
    await run();
    expect(h.events).toEqual(["update:approved", "expire"]);
  });

  it("a create that fails expires nothing", async () => {
    h.create.mockRejectedValue(
      new TRPCError({ code: "CONFLICT", message: "exists" })
    );
    await expect(run()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.expire).not.toHaveBeenCalled();
  });
});
