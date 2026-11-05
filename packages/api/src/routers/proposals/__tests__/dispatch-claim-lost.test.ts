import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { TRPCError } from "@trpc/server";
import {
  dispatchProposalApproval,
  proposalExecRegistry,
  type ProposalExecutorArgs,
} from "../execution-registry.js";
import {
  dispatchExternalOnce,
  STALE_DISPATCH_CLAIM_MS,
} from "../executors/shared.js";

/**
 * A re-approval of an external run whose claim it could not take (CP tickets
 * e74a086c, fff9cebc). The person approved a failed capability.run again and
 * read "This action is already being dispatched — nothing was re-sent." while
 * nothing ran and nothing had been sent: its twin approval had failed on
 * "installed but not enabled" and released the claim. The lost claim now says
 * what the row shows, and leaves the row to the attempt that owns it.
 *
 * The REAL `dispatchExternalOnce` and `dispatchProposalApproval` run here; only
 * the database is an in-memory proposal row.
 */

type Row = {
  status: string;
  externalDispatchedAt: Date | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
};

let row: Row;
/**
 * The CAS loses although the row reads free afterwards: the twin approval
 * released its claim between this attempt's CAS and its read.
 */
let releasedBetweenCasAndRead = false;

/** The proposal row behind the CAS claim, the release and the lost-claim read. */
const fakeDb = {
  update() {
    return {
      set(vals: { externalDispatchedAt: Date | null }) {
        return {
          where() {
            const isRelease = vals.externalDispatchedAt === null;
            let won = false;
            if (isRelease) row.externalDispatchedAt = null;
            else if (
              row.externalDispatchedAt === null &&
              !releasedBetweenCasAndRead
            ) {
              row.externalDispatchedAt = vals.externalDispatchedAt;
              won = true;
            }
            return Object.assign(Promise.resolve(undefined), {
              returning: async () => (won ? [{ id: "p1" }] : []),
            });
          },
        };
      },
    };
  },
  select() {
    return {
      from: () => ({
        where: () => ({ limit: async () => [{ ...row }] }),
      }),
    };
  },
} as unknown as Parameters<typeof dispatchExternalOnce>[2];

function args(): ProposalExecutorArgs {
  return {
    proposal: {
      id: "p1",
      targetType: "capability",
      targetId: "skill-1",
      proposalType: "capability.run",
      workspaceId: null,
      sessionId: null,
      projectId: null,
      agentUserId: null,
      data: {},
    } as ProposalExecutorArgs["proposal"],
    payload: null,
    userId: "user-1",
    input: { proposalId: "p1" } as ProposalExecutorArgs["input"],
    ctx: {} as ProposalExecutorArgs["ctx"],
    deps: {} as ProposalExecutorArgs["deps"],
  };
}

const NOT_ENABLED =
  'Nothing ran: "hetzner_cloud" is installed but not enabled. Enable it in Tools, then run it again.';

/** The executor every approval runs: one external send through the one door. */
function registerRun(send: () => Promise<{ delivered: boolean }>) {
  proposalExecRegistry.register({
    key: "*/*",
    async execute(a) {
      await dispatchExternalOnce(
        a.input.proposalId,
        send as Parameters<typeof dispatchExternalOnce>[1],
        fakeDb
      );
      row.status = "approved";
      return { success: true };
    },
  });
}

/** What `applyProposalApproval`'s recorder writes on a failed approval. */
const recorded: string[] = [];
async function onFailed(_id: string, reason: string) {
  recorded.push(reason);
  if (row.status !== "approved") {
    row.status = "approval_failed";
    row.rejectionReason = reason;
    row.reviewedAt = new Date();
  }
}

async function approve(): Promise<TRPCError | null> {
  try {
    await dispatchProposalApproval(args(), onFailed);
    return null;
  } catch (e) {
    return e as TRPCError;
  }
}

beforeEach(() => {
  proposalExecRegistry._reset();
  recorded.length = 0;
  releasedBetweenCasAndRead = false;
  row = {
    status: "pending",
    externalDispatchedAt: null,
    reviewedAt: null,
    rejectionReason: null,
  };
});
afterEach(() => proposalExecRegistry._reset());

describe("a lost dispatch claim says what really happened", () => {
  it("a double approval: the twin is running → 'running right now', and the twin's reason is the one recorded", async () => {
    let releaseSend!: () => void;
    const gate = new Promise<void>((r) => (releaseSend = r));
    registerRun(async () => {
      await gate;
      return { delivered: false, reason: NOT_ENABLED } as never;
    });

    const first = approve();
    await new Promise((r) => setTimeout(r, 0)); // the first holds the claim
    const second = await approve();
    releaseSend();
    const firstErr = await first;

    expect(second?.message).toMatch(/running right now/);
    expect(second?.message).not.toMatch(/being dispatched/);
    // Only the attempt that ran records a reason: the real one.
    expect(recorded).toHaveLength(1);
    expect(row.rejectionReason).toBe(firstErr?.message);
    expect(row.rejectionReason).toMatch(/installed but not enabled/);
    expect(row.externalDispatchedAt).toBeNull();
  });

  it("the twin already failed and released the claim → 'did not go through', never 'being dispatched', row untouched", async () => {
    row = {
      status: "approval_failed",
      externalDispatchedAt: null,
      reviewedAt: new Date(),
      rejectionReason: `Couldn't apply — ${NOT_ENABLED}`,
    };
    releasedBetweenCasAndRead = true;
    let sent = 0;
    registerRun(async () => {
      sent++;
      return { delivered: true };
    });
    const err = await approve();
    expect(sent).toBe(0);
    expect(err?.message).toMatch(/did not go through/);
    expect(err?.message).not.toMatch(/being dispatched/);
    expect(recorded).toHaveLength(0);
    expect(row.rejectionReason).toBe(`Couldn't apply — ${NOT_ENABLED}`);
  });

  it("the twin sent it → 'already ran', row left approved", async () => {
    row = {
      status: "approved",
      externalDispatchedAt: new Date(),
      reviewedAt: new Date(),
      rejectionReason: null,
    };
    registerRun(async () => ({ delivered: true }));
    const err = await approve();
    expect(err?.message).toMatch(/already ran/);
    expect(recorded).toHaveLength(0);
    expect(row.status).toBe("approved");
  });

  it("an earlier attempt ended without a clear answer (claim kept) → a refusal that says the send may have gone, recorded on the row", async () => {
    const claimedAt = new Date(Date.now() - 60_000);
    row = {
      status: "approval_failed",
      externalDispatchedAt: claimedAt,
      reviewedAt: new Date(claimedAt.getTime() + 5_000),
      rejectionReason: "Couldn't apply — the connection timed out.",
    };
    let sent = 0;
    registerRun(async () => {
      sent++;
      return { delivered: true };
    });
    const err = await approve();
    expect(sent).toBe(0);
    expect(err?.code).toBe("PRECONDITION_FAILED");
    expect(err?.message).toMatch(/may already have reached the service/);
    expect(recorded).toEqual([err?.message]);
  });

  it("a claim held far longer than any send by an attempt that never ended → the same refusal", async () => {
    row = {
      status: "pending",
      externalDispatchedAt: new Date(Date.now() - STALE_DISPATCH_CLAIM_MS - 1),
      reviewedAt: null,
      rejectionReason: null,
    };
    registerRun(async () => ({ delivered: true }));
    const err = await approve();
    expect(err?.message).toMatch(/may already have reached the service/);
  });

  it("a re-approval after a not-delivered run really retries (the claim was released)", async () => {
    let calls = 0;
    registerRun(async () => {
      calls++;
      return calls === 1
        ? ({ delivered: false, reason: NOT_ENABLED } as never)
        : { delivered: true };
    });
    expect((await approve())?.message).toMatch(/installed but not enabled/);
    expect(row.status).toBe("approval_failed");
    expect(await approve()).toBeNull();
    expect(calls).toBe(2);
    expect(row.status).toBe("approved");
  });

  it("a reason that ends with a full stop is not doubled ('run it again..')", async () => {
    registerRun(
      async () => ({ delivered: false, reason: NOT_ENABLED }) as never
    );
    const err = await approve();
    expect(err?.message).toBe(`Couldn't apply — ${NOT_ENABLED}`);
    expect(err?.message).not.toMatch(/\.\.$/);
  });
});
