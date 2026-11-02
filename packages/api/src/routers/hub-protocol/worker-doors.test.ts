/**
 * The goal's worker doors (goals that run, R2): what MCP and Hub REST share.
 *
 *  - an agent's enable / pause carries the agent to the services, whose rule
 *    door turns it into a proposal (governance is theirs, never decided here);
 *  - an overlap refusal comes back as `conflict` naming the holder, a missing
 *    worker as `not_found` — never a throw;
 *  - "run now" runs the worker's playbook through the shared playbook run
 *    door, filed in the goal the worker is enabled on.
 *
 * The services are proven against real SQL (`workers.pglite.test.ts`); here
 * they are stubs that record what the door passed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enable: vi.fn(),
  paused: vi.fn(),
  views: vi.fn(),
  enabled: vi.fn(),
  run: vi.fn(),
}));

vi.mock("../../services/playbooks/workers.js", () => {
  class WorkerScopeOverlapError extends Error {
    readonly reasonCode = "WORKER_SCOPE_OVERLAP";
    constructor(
      message: string,
      readonly holder: unknown
    ) {
      super(message);
    }
  }
  return {
    WorkerScopeOverlapError,
    enableWorker: h.enable,
    setWorkerPaused: h.paused,
    listWorkerViews: h.views,
    listEnabledWorkers: h.enabled,
  };
});
vi.mock("./playbook-doors.js", () => ({ runPlaybookDoor: h.run }));

import {
  enableWorkerDoor,
  listWorkersDoor,
  runWorkerDoor,
  setWorkerPausedDoor,
} from "./worker-doors.js";
import { WorkerScopeOverlapError } from "../../services/playbooks/workers.js";

const AGENT = { userId: "u-1", scopes: ["mcp.write"], agentUserId: "agent-1" };
const GOAL = "99999999-9999-4999-8999-999999999991";
const PROJECT = "77777777-7777-4777-8777-777777777777";

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
});

describe("worker doors", () => {
  it("an agent's enable reaches the service AS the agent (its rule door proposes)", async () => {
    h.enable.mockResolvedValue({ status: "proposed", proposalId: "p-1" });
    const out = await enableWorkerDoor(AGENT, {
      playbookId: "pb-1",
      activatorKey: "schedule:0 9 * * *",
      trackId: GOAL,
    });
    expect(h.enable).toHaveBeenCalledWith({
      userId: "u-1",
      agentUserId: "agent-1",
      playbookId: "pb-1",
      activatorKey: "schedule:0 9 * * *",
      trackId: GOAL,
    });
    expect(out).toEqual({
      kind: "result",
      result: { status: "proposed", proposalId: "p-1" },
    });
  });

  it("an overlap is a conflict naming the holder, never a throw", async () => {
    const holder = { ruleId: "r-0", scope: "space" };
    h.paused.mockRejectedValue(
      new (
        WorkerScopeOverlapError as unknown as new (
          m: string,
          h: unknown
        ) => Error
      )("Already runs for the whole space.", holder)
    );
    expect(
      await setWorkerPausedDoor(AGENT, { ruleId: "r-1", paused: false })
    ).toEqual({
      kind: "conflict",
      error: "Already runs for the whole space.",
      reasonCode: "WORKER_SCOPE_OVERLAP",
      holder,
    });
    expect(h.paused).toHaveBeenCalledWith({
      userId: "u-1",
      agentUserId: "agent-1",
      ruleId: "r-1",
      paused: false,
    });
  });

  it("a list needs the goal; the goal's workers come back as views", async () => {
    expect((await listWorkersDoor(AGENT, {})).kind).toBe("invalid");
    h.views.mockResolvedValue([{ ruleId: "r-1" }]);
    expect(await listWorkersDoor(AGENT, { trackId: GOAL })).toEqual({
      kind: "result",
      result: { items: [{ ruleId: "r-1" }] },
    });
    expect(h.views).toHaveBeenCalledWith({ userId: "u-1", trackId: GOAL });
  });

  it("run now runs the worker's playbook through the playbook run door, filed in its goal", async () => {
    h.enabled.mockResolvedValue([
      {
        ruleId: "r-1",
        playbookId: "pb-1",
        projectId: PROJECT,
        trackId: GOAL,
      },
    ]);
    h.run.mockResolvedValue({ kind: "result", result: { run: { id: "x" } } });
    const out = await runWorkerDoor(AGENT, { ruleId: "r-1", source: "mcp" });
    expect(h.run).toHaveBeenCalledWith(AGENT, {
      playbookId: "pb-1",
      projectId: PROJECT,
      trackId: GOAL,
      source: "mcp",
    });
    expect(out).toEqual({ kind: "result", result: { run: { id: "x" } } });
    expect(
      (await runWorkerDoor(AGENT, { ruleId: "nope", source: "mcp" })).kind
    ).toBe("not_found");
  });
});
