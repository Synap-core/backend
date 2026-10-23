/**
 * Approving a run proposal: the replay carries the approval, and a run that
 * did not start says WHY, one sentence per reason.
 *
 * Until 2026-10-12 every non-running outcome read "your workspace role cannot
 * run this playbook" — including the case where the replay had been gated on
 * the proposing AGENT (fixed in `playbooks.run`, see
 * `playbooks.run-approved-replay.test.ts`), skills that were not enabled, and
 * a cooling-down subject. Driven through the REAL registered executor with
 * the database and the playbooks router replaced by recorders.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  ctxs: [] as Array<Record<string, unknown>>,
  runs: [] as Array<Record<string, unknown>>,
  result: { status: "running" } as Record<string, unknown>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = (result: unknown) => {
    const q: Record<string, unknown> = {};
    for (const k of ["from", "where", "limit", "set"]) q[k] = () => q;
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
            name: "Evaluate tools",
            params: [],
            subjectProfile: null,
          }),
        },
      },
    },
    getWorkspaceMembership: async () => ({ role: "owner" }),
  };
});
vi.mock("../../../playbooks.js", () => ({
  playbooksRouter: {
    createCaller: (ctx: Record<string, unknown>) => {
      h.ctxs.push(ctx);
      return {
        run: async (args: Record<string, unknown>) => {
          h.runs.push(args);
          return h.result;
        },
      };
    },
  },
}));

import { registerPlaybookExecutors, notStartedReason } from "../playbook.js";
import { proposalExecRegistry } from "../../execution-registry.js";

registerPlaybookExecutors();
const executor = proposalExecRegistry.resolveExact("playbook/run")!;

const approve = () =>
  executor.execute({
    proposal: {
      id: "p-1",
      workspaceId: "ws-1",
      targetType: "playbook",
      proposalType: "run",
      agentUserId: "agent-raycast",
      sourceMessageId: null,
      data: { data: { playbookId: "pb-1" } },
    },
    userId: "owner-1",
    input: { proposalId: "p-1" },
    deps: {
      reportProposalOutcome: vi.fn(),
      emitProposalReviewed: vi.fn(),
    },
  } as never) as unknown as Promise<Record<string, unknown>>;

beforeEach(() => {
  h.ctxs.length = 0;
  h.runs.length = 0;
  h.result = { status: "running", session: { id: "s" }, run: { id: "r" } };
});

describe("approving an agent's run proposal", () => {
  it("replays WITH the approval; the approver owns the run, the agent is on its roster", async () => {
    await expect(approve()).resolves.toMatchObject({ success: true });
    expect(h.ctxs[0]).toMatchObject({
      userId: "owner-1",
      governanceProposalId: "p-1",
    });
    // Approving is the person accepting the agent's draft (draft-asks.ts):
    // an `agentUserId` here would make the agent own a session nobody else
    // can read (executors/playbook.ts, OWNERSHIP).
    expect(h.runs[0]).not.toHaveProperty("agentUserId");
    expect(h.runs[0]).toMatchObject({ agentIds: ["agent-raycast"] });
  });

  it("skills not enabled → names them and says approve again", async () => {
    h.result = {
      status: "blocked",
      message:
        '"Evaluate tools" uses skills that are not enabled yet: Web reader. Enable them in Settings → Capabilities, then approve again.',
    };
    await expect(approve()).rejects.toThrow(
      'Couldn\'t apply — "Evaluate tools" uses skills that are not enabled yet: Web reader. Enable them in Settings → Capabilities, then approve again.'
    );
  });

  it("cooling down → says so, not a role problem", async () => {
    h.result = {
      status: "skipped",
      message:
        "This record's last run failed recently, so another one was not started yet.",
    };
    await expect(approve()).rejects.toThrow(
      "Couldn't apply — this record's last run failed recently, so another one was not started yet."
    );
  });

  it("only a re-proposal on the approver's own check blames the role", () => {
    expect(notStartedReason({ status: "proposed", message: "x" })).toMatch(
      /^your workspace role cannot run this playbook/
    );
    expect(
      notStartedReason({ status: "skipped", message: "Nothing ready." })
    ).toBe("nothing ready");
    expect(notStartedReason({ status: "draft", message: "x" })).toMatch(
      /held as a draft/
    );
  });
});
