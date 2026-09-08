/**
 * APPROVING A `focus_session/update` MUST ACTUALLY CHANGE THE DELIVERABLES.
 *
 * THE BUG. Both proposing doors (`services/focus-sessions/update-session.ts`
 * and the Hub `PATCH /focus-sessions/:id`) carry `expectedOutputs`, `addOutput`
 * and `completeOutput` into the gate payload. The executor's non-close UPDATE
 * path built its `set` from a HAND-LISTED four — `status`, `progress`, `goal`,
 * `currentStage` — and wrote that. The three output fields were never applied.
 *
 * So an agent under governance that declared a blocker (`owner: 'human'`) filed
 * a proposal, the human approved it, the executor returned SUCCESS, and the slot
 * never changed. A success receipt for a change that did not happen — the
 * severed-approval-door shape, and the reason a governed agent could not hand
 * work back at all.
 *
 * WHAT THESE PIN. That the approved patch lands, that it lands THROUGH
 * `mergeExpectedOutputs` (a raw overwrite would re-introduce the erasure that
 * merge exists to stop), and that the `owner: 'human'` completion floor holds on
 * the approved path exactly as it does on the direct one — a floor that only one
 * of two paths enforces is not a floor.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

/** Every `db.update(...).set(...)` payload, tagged by table. */
const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
/** The session row both the executor and the row lock read. */
let sessionRow: Record<string, unknown> | null = null;
/** What the locked SELECT inside `updateExpectedOutputsLocked` returns. */
let lockedOutputs: unknown[] = [];

vi.mock("@synap/database", async (importOriginal) => {
  // PARTIAL mock — a total factory omitting an export kills the file at
  // COLLECTION, which reads as a pass in a summary.
  const actual = await importOriginal<typeof import("@synap/database")>();
  const tableName = (t: unknown): string =>
    t === actual.focusSessions ? "focus_sessions" : "proposals";
  const update = (table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        const entry = { table: tableName(table), values };
        updates.push(entry);
        return {
          returning: async () =>
            entry.table === "focus_sessions" ? [{ ...sessionRow }] : [],
          then: (resolve: (v: unknown) => unknown) => resolve(undefined),
        };
      },
    }),
  });
  const tx = {
    select: () => {
      const b: Record<string, unknown> = {
        from: () => b,
        where: () => b,
        for: async () => [{ expectedOutputs: lockedOutputs }],
      };
      return b;
    },
    update,
  };
  return {
    ...actual,
    db: {
      query: { focusSessions: { findFirst: async () => sessionRow } },
      // The executor's own idempotency read: this proposal is still pending.
      select: () => {
        const b: Record<string, unknown> = {
          from: () => b,
          where: async () => [{ status: "pending" }],
        };
        return b;
      },
      update,
      transaction: async (cb: (t: unknown) => unknown) => cb(tx),
    },
  };
});

vi.mock("../../../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: () => {},
}));

import { proposalExecRegistry } from "../../execution-registry.js";
import type { ProposalExecutorArgs } from "../../execution-registry.js";
import { registerFocusSessionExecutors } from "../focus-session.js";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const KEY = "focus_session/update";

function args(data: Record<string, unknown>): ProposalExecutorArgs {
  return {
    proposal: {
      id: "p-1",
      targetType: "focus_session",
      targetId: SESSION_ID,
      proposalType: "update",
      workspaceId: "ws-1",
      sessionId: SESSION_ID,
      projectId: null,
      agentUserId: "agent-1",
      sourceMessageId: null,
      // The gate payload lives at `proposals.data.data` — the request-shaped
      // envelope wraps it, and the executor reads the inner object.
      data: { data: { id: SESSION_ID, ...data } },
    },
    payload: null,
    userId: "human-1",
    input: { proposalId: "p-1" },
    ctx: {} as ProposalExecutorArgs["ctx"],
    deps: {
      db: null,
      emitProposalReviewed: () => {},
      reportProposalOutcome: () => {},
      stampProjectMembership: async () => {},
      resolveMessagingAccountForPlatform: async () => null,
    } as unknown as ProposalExecutorArgs["deps"],
  } as unknown as ProposalExecutorArgs;
}

/** The deliverables array the approval actually wrote, if it wrote one. */
function writtenOutputs(): Record<string, unknown>[] | undefined {
  const row = [...updates]
    .reverse()
    .find((u) => u.table === "focus_sessions" && u.values.expectedOutputs);
  return row?.values.expectedOutputs as Record<string, unknown>[] | undefined;
}

async function approve(data: Record<string, unknown>) {
  const executor = proposalExecRegistry.resolveExact(KEY)!;
  return (await executor.execute(args(data))) as unknown as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  registerFocusSessionExecutors();
  updates.length = 0;
  sessionRow = {
    id: SESSION_ID,
    status: "active",
    userId: "human-1",
    workspaceId: "ws-1",
    goal: "Ship the ownership pair",
    progress: 40,
  };
  lockedOutputs = [
    { kind: "document", label: "Launch brief", delegatedTo: "researcher" },
  ];
});

describe("focus_session/update — the deliverables half of an approval", () => {
  it("applies a wholesale expectedOutputs patch instead of dropping it", async () => {
    const result = await approve({
      goal: "Ship the ownership pair",
      expectedOutputs: [
        { kind: "document", label: "Launch brief" },
        { kind: "entity", label: "Signed NDA" },
      ],
    });

    expect(result.success).toBe(true);
    const written = writtenOutputs();
    expect(written).toBeDefined();
    expect(written!.map((o) => o.label)).toEqual([
      "Launch brief",
      "Signed NDA",
    ]);
  });

  it("goes THROUGH the merge — a naive patch cannot erase the delegation", async () => {
    await approve({
      expectedOutputs: [{ kind: "document", label: "Launch brief" }],
    });
    // The client sent two fields; the stored delegation survives because the
    // executor uses `mergeExpectedOutputs`, not a raw overwrite.
    expect(writtenOutputs()![0]).toMatchObject({ delegatedTo: "researcher" });
  });

  it("applies addOutput — including an agent declaring a blocker", async () => {
    await approve({
      addOutput: {
        kind: "entity",
        label: "Signed NDA",
        owner: "human",
        blockedReason: "physical",
        why: "Someone has to sign the paper copy",
      },
    });

    const added = writtenOutputs()!.at(-1)!;
    expect(added).toMatchObject({
      label: "Signed NDA",
      owner: "human",
      blockedReason: "physical",
      status: "pending",
    });
    // The server-observed clock is stamped on the approved path too.
    expect(added.owedSince).toEqual(expect.any(String));
  });

  it("applies completeOutput on a slot the agent owns", async () => {
    await approve({ completeOutput: "Launch brief" });
    expect(writtenOutputs()![0]).toMatchObject({ status: "done" });
  });

  it("honours the human-owned floor on the APPROVED path too", async () => {
    lockedOutputs = [
      {
        kind: "entity",
        label: "Signed NDA",
        owner: "human",
        blockedReason: "physical",
      },
    ];
    await approve({ completeOutput: "Signed NDA" });
    // A floor only the direct door enforces is not a floor: the approved path
    // would otherwise be the way around it.
    expect(writtenOutputs()![0]).not.toHaveProperty("status");
  });

  it("takes no output lock at all when the proposal carried none", async () => {
    await approve({ goal: "A new goal", progress: 60 });
    expect(writtenOutputs()).toBeUndefined();
    const scalar = updates.find((u) => u.table === "focus_sessions")!;
    expect(scalar.values).toMatchObject({ goal: "A new goal", progress: 60 });
  });
});
