/**
 * Approving a BATCH run proposal (one import's leads, coalesced into ONE
 * proposal by `proposeRulePlaybookRun`) starts ONE run per subject, through
 * the same door a single proposal uses (`playbooks.run`), at most
 * `BATCH_RUN_CONCURRENCY` at a time. A single proposal starts exactly its one
 * run, as before. Rejecting a proposal never reaches an executor (the reject
 * door has none), so a rejected batch starts nothing.
 *
 * Driven through the REAL registered `playbook/run` executor with the database
 * and the playbooks router replaced by recorders: what is pinned is WHICH runs
 * the approval starts and how many at once.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  inFlight: 0,
  maxInFlight: 0,
  failFor: new Set<string>(),
  sets: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = (result: unknown) => {
    const q: Record<string, unknown> = {};
    for (const k of ["from", "where", "limit"]) q[k] = () => q;
    q.set = (v: Record<string, unknown>) => {
      h.sets.push(v);
      return q;
    };
    q.returning = async () => result;
    q.then = (res: (v: unknown) => unknown) =>
      Promise.resolve(result).then(res);
    return q;
  };
  return {
    ...actual,
    db: {
      select: () => chain([{ status: "pending" }]),
      update: () => chain([{ id: "claimed" }]),
      query: {
        playbooks: {
          findFirst: async () => ({
            id: "pb-1",
            name: "Qualify a lead",
            params: [],
            subjectProfile: { profileSlug: "lead" },
          }),
        },
      },
    },
    getWorkspaceMembership: async () => ({ role: "owner" }),
  };
});
vi.mock("../../../playbooks.js", () => ({
  playbooksRouter: {
    createCaller: () => ({
      run: async (args: Record<string, unknown>) => {
        h.inFlight += 1;
        h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
        await new Promise((r) => setTimeout(r, 5));
        h.inFlight -= 1;
        h.runs.push(args);
        if (h.failFor.has(args.subjectId as string)) {
          throw new Error("subject gone");
        }
        return {
          status: "running",
          session: { id: `session-${args.subjectId as string}` },
          run: { id: `run-${args.subjectId as string}` },
        };
      },
    }),
  },
}));

import {
  registerPlaybookExecutors,
  BATCH_RUN_CONCURRENCY,
} from "../playbook.js";
import { proposalExecRegistry } from "../../execution-registry.js";

registerPlaybookExecutors();
const executor = proposalExecRegistry.resolveExact("playbook/run")!;

const approve = (
  inner: Record<string, unknown>,
  outer: Record<string, unknown> = {},
  agentUserId: string | null = null
) =>
  executor.execute({
    proposal: {
      id: "p-1",
      workspaceId: "ws-1",
      targetType: "playbook",
      proposalType: "run",
      agentUserId,
      sourceMessageId: null,
      data: { ...outer, data: { playbookId: "pb-1", params: {}, ...inner } },
    },
    userId: "owner-1",
    input: { proposalId: "p-1" },
    deps: {
      reportProposalOutcome: vi.fn(),
      emitProposalReviewed: vi.fn(),
    },
  } as never) as unknown as Promise<Record<string, unknown>>;

beforeEach(() => {
  h.runs.length = 0;
  h.inFlight = 0;
  h.maxInFlight = 0;
  h.failFor.clear();
  h.sets.length = 0;
});

/** The `data.runResult` the approval stamped on the proposal, if any. */
const stampedRunResult = () =>
  (
    h.sets.find((v) => v.status === "approved")?.data as
      | {
          runResult?: {
            started: Array<Record<string, unknown>>;
            failed: string[];
          };
        }
      | undefined
  )?.runResult;

describe("approving a batch run proposal", () => {
  it("starts ONE run per subject, through the same door, a few at a time", async () => {
    const subjects = Array.from({ length: 10 }, (_, i) => `lead-${i}`);
    const res = await approve({ subjectId: subjects[0], subjectIds: subjects });
    expect(h.runs.map((r) => r.subjectId).sort()).toEqual([...subjects].sort());
    expect(h.runs.every((r) => r.playbookId === "pb-1")).toBe(true);
    expect(h.maxInFlight).toBeLessThanOrEqual(BATCH_RUN_CONCURRENCY);
    expect(h.maxInFlight).toBeGreaterThan(1);
    expect(res).toMatchObject({
      success: true,
      batch: { started: 10, failed: [] },
    });
    // Every started run is recorded ON the proposal, with the session to open.
    const receipt = stampedRunResult();
    expect(receipt?.started).toHaveLength(10);
    expect(
      receipt!.started.map((r) => `${r.subjectId}>${r.sessionId}`).sort()
    ).toEqual(subjects.map((s) => `${s}>session-${s}`).sort());
    expect(receipt?.failed).toEqual([]);
  });

  it("a subject that can no longer run is reported, never stops its siblings", async () => {
    h.failFor.add("lead-2");
    const subjects = ["lead-0", "lead-1", "lead-2", "lead-3"];
    const res = await approve({ subjectId: subjects[0], subjectIds: subjects });
    expect(h.runs).toHaveLength(4);
    expect(res).toMatchObject({ batch: { started: 3, failed: ["lead-2"] } });
    expect(stampedRunResult()?.failed).toEqual(["lead-2"]);
  });

  it("a single proposal starts exactly its one run and records its session", async () => {
    const res = await approve({ subjectId: "lead-solo" });
    expect(h.runs.map((r) => r.subjectId)).toEqual(["lead-solo"]);
    expect(res).not.toHaveProperty("batch");
    // The session the approval created is on the proposal (the door the
    // person opens next) and in the approve response.
    expect(stampedRunResult()).toEqual({
      started: [
        {
          subjectId: "lead-solo",
          sessionId: "session-lead-solo",
          runId: "run-lead-solo",
        },
      ],
      failed: [],
    });
    expect(res).toMatchObject({ primaryId: "session-lead-solo" });
  });

  it("a run that starts after an earlier failed attempt clears that failure", async () => {
    await approve(
      { subjectId: "lead-solo" },
      { failure: { errorClass: "validation" }, automationId: "auto-1" }
    );
    const approved = h.sets.find((v) => v.status === "approved")!;
    expect(approved.rejectionReason).toBeNull();
    const data = approved.data as Record<string, unknown>;
    expect(data).not.toHaveProperty("failure");
    // Everything else the proposal carried is kept.
    expect(data.automationId).toBe("auto-1");
    expect(data.data).toMatchObject({ subjectId: "lead-solo" });
  });
});

describe("approving an AGENT-filed run proposal", () => {
  it("the person who approved owns the run; the agent that asked is on its roster", async () => {
    await approve(
      { subjectId: "post-1", agentIds: ["agent-extra"] },
      {},
      "agent-asker"
    );
    expect(h.runs).toHaveLength(1);
    // No `agentUserId` reaches the run door: it would make the AGENT the
    // session's owner (runPlaybook's actorId) and hide it from the person.
    expect(h.runs[0]).not.toHaveProperty("agentUserId");
    expect(h.runs[0].agentIds).toEqual(["agent-asker", "agent-extra"]);
  });
});
