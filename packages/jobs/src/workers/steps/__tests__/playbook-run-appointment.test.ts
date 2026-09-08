import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * APPOINTMENT MODE — `focus_sessions.status = 'scheduled'` producer.
 *
 * Two things must hold, and they fail in two completely different places, so
 * they are pinned two different ways:
 *
 *  1. BEHAVIOURAL — a `playbook_run` node with `mode: "appointment"` reaches the
 *     SESSION SCHEDULER and never the PLAYBOOK RUNNER. The runner is where the
 *     executor spine's agent kickoff (`triggerAutoRespond`) lives, so "no agent
 *     is dispatched at an appointment" is exactly the assertion `playbookRunner`
 *     was not called. Absent / `"run"` mode must keep reaching the runner, which
 *     is every node authored before this field existed.
 *
 *  2. PROJECTION — `automation-executor.ts`'s top-level `case "playbook_run"`
 *     rebuilds the node data FIELD BY FIELD (its own comment says so), so an
 *     unlisted field is silently dropped there while surviving the loop-child
 *     path's wholesale cast. A dropped `mode` means an appointment node executes
 *     as a RUN — dispatching an agent at the session a human was meant to open —
 *     with every type green. The set of fields is DERIVED from the step's own
 *     `data` parameter type rather than hand-listed, so a field added to the step
 *     joins this scan by existing.
 */

const { runnerMock, schedulerMock, entityFindFirstMock } = vi.hoisted(() => ({
  runnerMock: vi.fn(async () => ({
    run: { id: "run-1", status: "running" },
    session: { id: "sess-run", channelId: "chan-1" },
  })),
  schedulerMock: vi.fn(async () => ({
    session: { id: "sess-appt", channelId: null },
    outcome: "created" as const,
    missedCount: 0,
  })),
  entityFindFirstMock: vi.fn(async () => undefined),
}));

vi.mock("@synap/database", () => ({
  db: { query: { entities: { findFirst: entityFindFirstMock } } },
  eq: vi.fn(),
  entities: {},
  proposals: {},
  ProposalStatus: { PENDING: "pending" },
  insertPendingProposal: vi.fn(),
  verifyPermission: vi.fn(),
  and: vi.fn(),
}));
vi.mock("@synap/database/agent-governance", () => ({
  // No agent in the chain ⇒ `guardProducerEffect` is a pass-through, which is
  // the ordinary cron case this feature ships for.
  resolveAgentGovernanceDecision: vi.fn(async () => ({
    decision: "not-agent" as const,
  })),
}));
vi.mock("@synap/governance-policy", () => ({
  requiredPermissionFor: vi.fn(() => "write"),
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { executePlaybookRun } from "../playbook-run.js";
import {
  registerPlaybookRunner,
  registerSessionScheduler,
} from "../../capability-dispatch.js";
import type { StepContext } from "../../automation-executor-types.js";

const SLOT = "2026-09-14T09:00:00.000Z";

const context = (payload: Record<string, unknown> = {}) =>
  ({
    trigger: { payload },
    steps: {},
    automation: { id: "auto-1", state: {} },
  }) as unknown as StepContext;

beforeEach(() => {
  runnerMock.mockClear();
  schedulerMock.mockClear();
  registerPlaybookRunner(runnerMock as never);
  registerSessionScheduler(schedulerMock as never);
});

describe("playbook_run — appointment mode never dispatches an agent", () => {
  it('mode:"appointment" → session scheduler called, playbook runner NOT called', async () => {
    const output = await executePlaybookRun(
      { playbookId: "pb-1", mode: "appointment" },
      context({ type: "cron", scheduledAt: SLOT }),
      "ws-1",
      "user-1"
    );

    // The kickoff lives behind the runner. Not calling it IS the guarantee.
    expect(runnerMock).not.toHaveBeenCalled();
    expect(schedulerMock).toHaveBeenCalledTimes(1);

    // Reachability, not shape: assert the VALUES arrive at the scheduler.
    const input = (schedulerMock.mock.calls as unknown[][])[0][0] as {
      playbookId?: string;
      workspaceId: string;
      userId: string;
      scheduledFor: Date;
    };
    expect(input.playbookId).toBe("pb-1");
    expect(input.workspaceId).toBe("ws-1");
    expect(input.userId).toBe("user-1");
    // The slot is the CRON's due moment off the trigger payload, not the clock —
    // a worker that picks the job up late still records the scheduled moment.
    expect(input.scheduledFor.toISOString()).toBe(SLOT);

    // Step-output contract: `status` is the SESSION's status. Reporting
    // "running" here would be a lie a downstream condition could branch on.
    expect(output).toMatchObject({
      sessionId: "sess-appt",
      status: "scheduled",
      outcome: "created",
      missedCount: 0,
    });
  });

  it("no `mode` (every pre-existing node) → playbook runner called, scheduler NOT called", async () => {
    const output = await executePlaybookRun(
      { playbookId: "pb-1" },
      context({ type: "cron", scheduledAt: SLOT }),
      "ws-1",
      "user-1"
    );

    expect(schedulerMock).not.toHaveBeenCalled();
    expect(runnerMock).toHaveBeenCalledTimes(1);
    expect(output).toMatchObject({ runId: "run-1", status: "running" });
  });

  it('mode:"run" is explicitly the same path as absent', async () => {
    await executePlaybookRun(
      { playbookId: "pb-1", mode: "run" },
      context({}),
      "ws-1",
      "user-1"
    );
    expect(schedulerMock).not.toHaveBeenCalled();
    expect(runnerMock).toHaveBeenCalledTimes(1);
  });

  it("appointment with no cron stamp falls back to now (never throws, never NaN)", async () => {
    const before = Date.now();
    await executePlaybookRun(
      { playbookId: "pb-1", mode: "appointment" },
      // A manual test-run / event trigger carries no `scheduledAt`.
      context({ scheduledAt: "not-a-date" }),
      "ws-1",
      "user-1"
    );
    const input = (schedulerMock.mock.calls as unknown[][])[0][0] as {
      scheduledFor: Date;
    };
    expect(Number.isNaN(input.scheduledFor.getTime())).toBe(false);
    expect(input.scheduledFor.getTime()).toBeGreaterThanOrEqual(before);
  });
});

/**
 * PROJECTION PARITY — every field the step's `data` parameter declares must be
 * forwarded by automation-executor.ts's field-by-field top-level call site.
 *
 * WHAT THIS DOES NOT COVER, measured: the granularity is the presence of a
 * `<field>: data.<field>` pair inside the `case "playbook_run"` block. It cannot
 * see a field forwarded with a wrong VALUE (`mode: data.agentType` would pass),
 * and it does not check the loop-child call site — that one passes `childNode.data`
 * wholesale, so it cannot drop a field by omission and has nothing to scan.
 */
describe("tripwire: playbook_run node fields survive the executor's field-by-field projection", () => {
  const stepSrc = readFileSync(
    join(__dirname, "..", "playbook-run.ts"),
    "utf8"
  );
  const execSrc = readFileSync(
    join(__dirname, "..", "..", "automation-executor.ts"),
    "utf8"
  );

  /**
   * DERIVE the field set from the step's own `data` parameter type — the object
   * literal type between `data: {` and the following `},\n  context: StepContext`.
   * Hand-maintaining this list is the documented way these scans go blind.
   */
  const declared = (() => {
    const start = stepSrc.indexOf("  data: {");
    const end = stepSrc.indexOf("  context: StepContext,", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = stepSrc.slice(start, end);
    // Only property lines at the type's top level (4-space indent), so nested
    // JSDoc prose and the `Record<string, string>` value types cannot leak in.
    return [...block.matchAll(/^ {4}(\w+)\??:/gm)].map((m) => m[1]);
  })();

  const caseBlock = (() => {
    const start = execSrc.indexOf('case "playbook_run": {');
    expect(start).toBeGreaterThan(-1);
    // The block ends at the `break;` that closes the case.
    const end = execSrc.indexOf("break;", start);
    expect(end).toBeGreaterThan(start);
    return execSrc.slice(start, end);
  })();

  it("the scan is not vacuous — it sees the fields it hunts", () => {
    // If the regex or the slice boundaries stop matching, `declared` silently
    // empties and every assertion below passes on nothing.
    expect(declared.length).toBeGreaterThanOrEqual(5);
    expect(declared).toContain("playbookId");
    expect(declared).toContain("mode");
    expect(caseBlock).toContain("executePlaybookRun(");
  });

  it("every declared node field is forwarded explicitly", () => {
    const missing = declared.filter(
      (field) =>
        !new RegExp(`\\b${field}:\\s*data\\.${field}\\b`).test(caseBlock)
    );
    expect(missing).toEqual([]);
  });
});
