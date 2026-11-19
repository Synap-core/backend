/**
 * A LINK starts no loop: the real `executePlaybookRun`, the one place a
 * `run_ended` link starts a run.
 *
 *   - a link whose playbook is already in its chain (`linkWouldLoop`, its
 *     SQL in `utils/link-lineage.pglite.test.ts`) starts and files NOTHING,
 *     in run AND propose mode (`link_loop`);
 *   - a link hop does not deepen the chain: the run it starts carries the
 *     depth of the run that ended, so a chain of playbooks is never cut at
 *     the generic depth floor; any other node keeps its depth;
 *   - a node that is not a link never asks the guard.
 *
 * NEGATIVE CONTROLS: the two `link_loop` rows fail with the guard removed
 * (the runner / proposal door is called); the depth row fails with the
 * relief removed (the link run keeps depth 2).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  runnerMock: vi.fn(async (_input: unknown) => ({
    run: { id: "run-1", status: "running" },
    session: { id: "sess-run", channelId: "chan-1" },
  })),
  proposeMock: vi.fn(async (_input: unknown) => ({
    proposalId: "prop-1",
    deduped: false,
  })),
  loops: false,
  asked: [] as Array<{ endedSessionId: string; playbookId: string }>,
}));

vi.mock("@synap/database", () => ({
  db: {
    query: {
      entities: { findFirst: vi.fn(async () => undefined) },
      focusSessions: { findFirst: vi.fn(async () => undefined) },
    },
    update: () => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }),
  },
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  entities: {},
  events: {},
  focusSessions: {},
  countWorkerPendingApprovals: vi.fn(async () => 0),
  WORKER_HELD_OUTPUT_KEY: "held",
}));
vi.mock("../../../utils/automation-governance.js", () => ({
  guardProducerEffect: vi.fn(async () => ({ proceed: true })),
  PolicyBlockedError: class extends Error {},
  proposeRulePlaybookRun: h.proposeMock,
}));
vi.mock("../../../utils/run-in-flight.js", () => ({
  findInFlightRunSession: vi.fn(async () => null),
}));
vi.mock("../../../utils/link-lineage.js", () => ({
  linkWouldLoop: vi.fn(
    async (i: { endedSessionId: string; playbookId: string }) => {
      h.asked.push(i);
      return h.loops;
    }
  ),
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { executePlaybookRun } from "../playbook-run.js";
import {
  registerPlaybookReadinessGate,
  registerPlaybookRunner,
} from "../../capability-dispatch.js";
import type { StepContext } from "../../automation-executor-types.js";

const PB = "22222222-2222-4222-8222-222222222222";
const ENDED = "33333333-3333-4333-8333-333333333333";
const AUTOMATION = {
  automationRunId: "arun-1",
  automationId: "auto-1",
  chainDepth: 2,
  rootRunId: "arun-0",
  chainAutomationIds: ["auto-0", "auto-1"],
};
const LINK_WORKER = {
  key: "run_ended:Ship a change:delivered",
  size: "per_thing",
  profileSlug: "devplane_feature",
} as never;

const context = () =>
  ({
    trigger: {
      payload: {
        eventType: "focus_session.closed.completed",
        subjectId: ENDED,
        data: { sessionId: ENDED, status: "closed" },
      },
    },
    steps: {},
    automation: { id: "auto-1", state: {} },
  }) as unknown as StepContext;

const runnerInput = () =>
  h.runnerMock.mock.calls[0]![0] as {
    chainContext?: { chainDepth: number; chainAutomationIds: string[] };
  };

beforeEach(() => {
  h.runnerMock.mockClear();
  h.proposeMock.mockClear();
  h.loops = false;
  h.asked = [];
  registerPlaybookRunner(h.runnerMock as never);
  registerPlaybookReadinessGate((async () => ({ ready: true })) as never);
});

describe("a link never starts a playbook already in its chain", () => {
  it("run mode: starts nothing (link_loop), having asked about THIS playbook after THIS close", async () => {
    h.loops = true;
    const out = await executePlaybookRun(
      { playbookId: PB, worker: LINK_WORKER },
      context(),
      "ws-1",
      "user-1",
      AUTOMATION
    );
    expect(out).toMatchObject({ status: "skipped", reason: "link_loop" });
    expect(h.asked).toEqual([{ endedSessionId: ENDED, playbookId: PB }]);
    expect(h.runnerMock).not.toHaveBeenCalled();
  });

  it("propose mode: files nothing (link_loop)", async () => {
    h.loops = true;
    const out = await executePlaybookRun(
      { playbookId: PB, mode: "propose", worker: LINK_WORKER },
      context(),
      "ws-1",
      "user-1",
      AUTOMATION
    );
    expect(out).toMatchObject({ status: "skipped", reason: "link_loop" });
    expect(h.proposeMock).not.toHaveBeenCalled();
  });

  it("a link hop keeps the depth of the run that ended; the cycle ids still ride", async () => {
    await executePlaybookRun(
      { playbookId: PB, worker: LINK_WORKER },
      context(),
      "ws-1",
      "user-1",
      AUTOMATION
    );
    expect(runnerInput().chainContext).toMatchObject({
      chainDepth: 1,
      chainAutomationIds: ["auto-0", "auto-1"],
    });
  });

  it("a node that is not a link keeps its depth and never asks the guard", async () => {
    await executePlaybookRun(
      {
        playbookId: PB,
        worker: {
          key: "created",
          size: "per_thing",
          profileSlug: "x",
        } as never,
      },
      context(),
      "ws-1",
      "user-1",
      AUTOMATION
    );
    expect(runnerInput().chainContext).toMatchObject({ chainDepth: 2 });
    expect(h.asked).toEqual([]);
  });
});
