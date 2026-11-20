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
  inFlight: null as null | { id: string; status: string; title: string | null },
  /** Overrides on the playbook row the executor reads at approval. */
  playbook: {} as Record<string, unknown>,
  /** Every `db.update` (the dispatch claim is the first one). */
  updates: 0,
}));

vi.mock("@synap/jobs/utils/run-in-flight.js", () => ({
  findInFlightRunSession: async () => h.inFlight,
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
      // The proposal door's one statement (`WITH … UPDATE`).
      $with: () => ({ as: () => ({}) }),
      with() {
        return this;
      },
      select: () => chain([{ status: "pending" }]),
      update: () => {
        h.updates += 1;
        return chain([{ id: "claimed" }]);
      },
      query: {
        playbooks: {
          findFirst: async () => ({
            id: "pb-1",
            name: "Evaluate tools",
            params: [],
            subjectProfile: null,
            ...h.playbook,
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
  h.inFlight = null;
  h.playbook = {};
  h.updates = 0;
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
        '"Evaluate tools" uses skills that are not enabled yet: Web reader. Enable them in Tools, then approve again.',
    };
    await expect(approve()).rejects.toThrow(
      'Couldn\'t apply — "Evaluate tools" uses skills that are not enabled yet: Web reader. Enable them in Tools, then approve again.'
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

  it("already running (one live run per object) → names the live run, starts nothing, approve again later", async () => {
    h.result = {
      status: "already_running",
      session: { id: "sess-live" },
      run: null,
      reason: "live_run",
      message: "x",
    };
    await expect(approve()).rejects.toThrow(
      /Couldn't apply — this playbook is already running on this record \(session sess-live\), so approving did not start a second run/
    );
  });

  it("a run asked as 'start another' is replayed as one", async () => {
    await executor.execute({
      proposal: {
        id: "p-3",
        workspaceId: "ws-1",
        targetType: "playbook",
        proposalType: "run",
        agentUserId: null,
        sourceMessageId: null,
        data: {
          data: { playbookId: "pb-1", startAnother: true },
        },
      },
      userId: "owner-1",
      input: { proposalId: "p-3" },
      deps: {
        reportProposalOutcome: vi.fn(),
        emitProposalReviewed: vi.fn(),
      },
    } as never);
    expect(h.runs[0]).toMatchObject({ startAnother: true });
    // …and one asked without it is replayed without it.
    await approve();
    expect(h.runs[1]).not.toHaveProperty("startAnother");
  });

  it("a playbook of ANOTHER space is refused BEFORE the dispatch claim, with its real reason (e93cf92b)", async () => {
    // Thrown inside `dispatchExternalOnce` it kept the claim, and the next
    // approval read "may already have reached the service" about a run that
    // never started. Now: no claim, no run, the reason names where it lives.
    h.playbook = { workspaceId: "ws-home" };
    await expect(approve()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        'Cannot apply this approval: Playbook "Evaluate tools" (pb-1) lives in space ws-home, so it cannot run in space ws-1: run it in space ws-home. Nothing was started.',
    });
    expect(h.updates).toBe(0);
    expect(h.runs).toHaveLength(0);
  });

  it("a playbook archived since it was proposed is refused before the claim too", async () => {
    h.playbook = { status: "archived" };
    await expect(approve()).rejects.toThrow(/is archived, so it does not run/);
    expect(h.updates).toBe(0);
    expect(h.runs).toHaveLength(0);
  });

  it("CONTROL: a playbook of THIS space is claimed and run", async () => {
    h.playbook = { workspaceId: "ws-1", status: "active" };
    await expect(approve()).resolves.toMatchObject({ success: true });
    expect(h.updates).toBeGreaterThan(0);
    expect(h.runs).toHaveLength(1);
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

describe("approving a RULE's run on a subject a run is still working on", () => {
  // Live 9 Nov 2026: 100d7d65 (the "enters Briefed" activator's run of
  // Produce Content) waited while run 12dbd086 was open on the same post.
  const approveRule = (source: string | undefined) =>
    executor.execute({
      proposal: {
        id: "p-2",
        workspaceId: "ws-1",
        targetType: "playbook",
        proposalType: "run",
        agentUserId: null,
        sourceMessageId: null,
        data: {
          ...(source ? { source } : {}),
          automationId: "auto-1",
          data: { playbookId: "pb-1", params: {}, subjectId: "post-1" },
        },
      },
      userId: "owner-1",
      input: { proposalId: "p-2" },
      deps: {
        reportProposalOutcome: vi.fn(),
        emitProposalReviewed: vi.fn(),
      },
    } as never) as unknown as Promise<Record<string, unknown>>;

  it("refuses, names the open run, starts nothing", async () => {
    h.inFlight = {
      id: "sess-open",
      status: "active",
      title: "Produce Content · Video 01",
    };
    await expect(approveRule("automation")).rejects.toThrow(
      /already running on this record \("Produce Content · Video 01", session sess-open\)/
    );
    expect(h.runs).toHaveLength(0);
  });

  it("starts the run when none is in flight", async () => {
    await expect(approveRule("automation")).resolves.toMatchObject({
      success: true,
    });
    expect(h.runs).toHaveLength(1);
  });

  it("a person's own run proposal is theirs to repeat", async () => {
    h.inFlight = { id: "sess-open", status: "active", title: null };
    await expect(approveRule(undefined)).resolves.toMatchObject({
      success: true,
    });
    expect(h.runs).toHaveLength(1);
  });
});
