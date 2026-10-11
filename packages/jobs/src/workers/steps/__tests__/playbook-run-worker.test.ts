/**
 * STAGE WORKER (work model L4) — a `playbook_run` node carrying a `worker`
 * spec.
 *
 *  A. RUN: the step hands the spine the WHOLE spec plus the enablement's
 *     automation (what the backlog / in-flight / ceiling counts key on); a
 *     node without one sends no `worker` key (every existing node unchanged).
 *  B. PROPOSE (a per_thing worker): past `maxPendingApprovals` waiting on a
 *     person the step files nothing (`approvals_backlog`); at max − 1 it files.
 *     The boundary row rules out `>` for `>=`.
 *
 * The spine's own gate and per_moment batch are proven against SQL in
 * api `run-playbook.worker.pglite.test.ts`; the two halves meet at the
 * `registerPlaybookRunner` slot, whose input type both packages compile
 * against (apps/api boot wiring).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  runnerMock: vi.fn(async (_input: unknown) => ({
    run: { id: "run-1", status: "running" },
    session: { id: "sess-run", channelId: "chan-1" },
  })),
  pending: 0,
  proposeMock: vi.fn(async () => ({ proposalId: "prop-1", deduped: false })),
}));

vi.mock("@synap/database", () => ({
  db: {
    query: { entities: { findFirst: vi.fn(async () => undefined) } },
    update: () => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }),
  },
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  entities: {},
  events: {},
  countWorkerPendingApprovals: vi.fn(async () => h.pending),
}));
vi.mock("../../../utils/automation-governance.js", () => ({
  guardProducerEffect: vi.fn(async () => ({ proceed: true })),
  PolicyBlockedError: class extends Error {},
  proposeRulePlaybookRun: h.proposeMock,
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { executePlaybookRun } from "../playbook-run.js";
import { registerPlaybookRunner } from "../../capability-dispatch.js";
import type { StepContext } from "../../automation-executor-types.js";

const context = () =>
  ({
    trigger: { payload: {} },
    steps: {},
    automation: { id: "auto-1", state: {} },
  }) as unknown as StepContext;
const automationContext = {
  automationId: "auto-1",
  automationRunId: "arun-1",
  chainDepth: 0,
} as never;

const SPEC = {
  key: "count:review",
  size: "per_moment" as const,
  profileSlug: "deal",
  status: "review",
  minCount: 3,
  maxPendingApprovals: 4,
  writes: "propose" as const,
};

beforeEach(() => {
  h.runnerMock.mockClear();
  h.proposeMock.mockClear();
  h.pending = 0;
  registerPlaybookRunner(h.runnerMock as never);
});

describe("A. a worker node hands the spine its spec + enablement", () => {
  it("the whole spec and the automation reach runPlaybook", async () => {
    await executePlaybookRun(
      { playbookId: "pb-1", worker: SPEC },
      context(),
      "ws-1",
      "user-1",
      automationContext
    );
    const input = h.runnerMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.worker).toEqual({ ...SPEC, automationId: "auto-1" });
  });

  it("an ordinary node sends no worker key", async () => {
    await executePlaybookRun(
      { playbookId: "pb-1" },
      context(),
      "ws-1",
      "user-1",
      automationContext
    );
    const input = h.runnerMock.mock.calls[0]![0] as Record<string, unknown>;
    expect("worker" in input).toBe(false);
  });
});

describe("B. a propose-mode worker is held by its backlog", () => {
  const fire = () =>
    executePlaybookRun(
      {
        playbookId: "pb-1",
        mode: "propose",
        worker: { ...SPEC, size: "per_thing", writes: undefined },
      },
      context(),
      "ws-1",
      "user-1",
      automationContext
    );

  it("at maxPendingApprovals waiting: files nothing, says approvals_backlog", async () => {
    h.pending = 4;
    expect(await fire()).toEqual({
      status: "skipped",
      reason: "approvals_backlog",
    });
    expect(h.proposeMock).not.toHaveBeenCalled();
    expect(h.runnerMock).not.toHaveBeenCalled();
  });

  it("one under: files the proposal", async () => {
    h.pending = 3;
    expect(await fire()).toEqual({ status: "proposed", proposalId: "prop-1" });
    expect(h.proposeMock).toHaveBeenCalledOnce();
  });
});
