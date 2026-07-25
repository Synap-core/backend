/**
 * F2 safety floor — the automation chain depth guard holds ACROSS the agent
 * boundary.
 *
 * The hole: a cron→agent turn sends A2AI with no automationContext, so the
 * agent's Hub writes emit events the matcher treated as depth 0 → a
 * cron→agent→write→automation→agent→… chain was unbounded. The fix stamps the
 * spawning run's chain context onto the focus session, and the matcher
 * re-derives it (keyed by the event's sessionId) when no explicit context is
 * present. This drives the REAL `handleAutomationTriggerMatch` and proves:
 *   - depth increments across the agent boundary (session depth 2 → child run 3)
 *   - the chain STOPS at MAX_CHAIN_DEPTH (3): a session at depth 3 matches nothing
 *   - cycle detection holds (an automation already in the chain is skipped)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const bossSend = vi.fn().mockResolvedValue(undefined);

// Session row returned to BOTH deriveSessionChainContext and the playbook-scope
// lookup. `playbookId: null` keeps the playbook-scoped branch inert so the only
// automations considered are the workspace-active set below.
let sessionRow: {
  metadata: Record<string, unknown>;
  playbookId: string | null;
} | null = null;

let activeAutomationsResult: Array<{
  id: string;
  triggerConfig: Record<string, unknown>;
  workspaceId: string;
}> = [];

/** A drizzle-builder-shaped thenable: every chain method returns itself, and
 *  awaiting it (or calling .returning()) resolves to `result`. */
function makeThenable(result: unknown) {
  const p: Record<string, unknown> = {};
  const chain = () => p;
  p.from = chain;
  p.where = chain;
  p.set = chain;
  p.values = chain;
  p.returning = () => Promise.resolve(result);
  p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return p;
}

const selectSpy = vi.fn((..._args: unknown[]) =>
  makeThenable(activeAutomationsResult)
);

vi.mock("@synap/events", () => ({
  getBoss: () => ({ send: bossSend }),
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@synap/database", () => ({
  db: {
    query: {
      focusSessions: { findFirst: () => Promise.resolve(sessionRow) },
      links: { findMany: () => Promise.resolve([]) },
    },
    select: (...args: unknown[]) => selectSpy(...args),
    insert: () => makeThenable([{ id: "run-child" }]),
    update: () => makeThenable(undefined),
  },
  eq: () => ({}),
  and: () => ({}),
  inArray: () => ({}),
  drizzleSql: () => ({}),
  automations: { id: "id", workspaceId: "workspace_id", runCount: 0 },
  automationRuns: {},
  playbookAutomations: {},
  workspaceMembers: {},
  workspaces: {},
}));

const { handleAutomationTriggerMatch } =
  await import("./automation-trigger-matcher.js");

const AGENT_EVENT = {
  eventType: "entity.create.completed",
  subjectId: "entity-1",
  userId: "user-1",
  workspaceId: "ws-1",
  data: { profileSlug: "person" },
  // The agent's Hub write carries the focus session but NO automationContext.
  sessionId: "session-1",
} as const;

describe("F2: automation chain depth floor across the agent boundary", () => {
  beforeEach(() => {
    bossSend.mockClear();
    selectSpy.mockClear();
    activeAutomationsResult = [
      {
        id: "auto-2",
        triggerConfig: { eventPattern: "entity.create.completed" },
        workspaceId: "ws-1",
      },
    ];
  });

  it("re-derives session chain depth and increments it for the child run", async () => {
    // Spawning run was at depth 2; auto-1 already in the chain.
    sessionRow = {
      playbookId: null,
      metadata: {
        automationChainContext: {
          automationId: "auto-1",
          automationRunId: "run-0",
          chainDepth: 2,
          rootRunId: "run-0",
          chainAutomationIds: ["auto-1"],
        },
      },
    };

    await handleAutomationTriggerMatch({ data: { ...AGENT_EVENT } });

    // A run WAS created and dispatched — depth 2 is below the limit.
    expect(bossSend).toHaveBeenCalledTimes(1);
    const [queue, payload] = bossSend.mock.calls[0] as [
      string,
      {
        automationContext: { chainDepth: number; chainAutomationIds: string[] };
      },
    ];
    expect(queue).toBe("automation-execute");
    // Depth incremented across the agent boundary: 2 → 3.
    expect(payload.automationContext.chainDepth).toBe(3);
    // The new automation joins the chain for downstream cycle detection.
    expect(payload.automationContext.chainAutomationIds).toEqual([
      "auto-1",
      "auto-2",
    ]);
  });

  it("STOPS at MAX_CHAIN_DEPTH (3): a session already at depth 3 matches nothing", async () => {
    sessionRow = {
      playbookId: null,
      metadata: {
        automationChainContext: {
          automationId: "auto-1",
          automationRunId: "run-0",
          chainDepth: 3,
          rootRunId: "run-0",
          chainAutomationIds: ["auto-1"],
        },
      },
    };

    await handleAutomationTriggerMatch({ data: { ...AGENT_EVENT } });

    // Depth-limit guard returns BEFORE querying/dispatching any automation.
    expect(bossSend).not.toHaveBeenCalled();
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("skips an automation already in the chain (cycle prevention)", async () => {
    sessionRow = {
      playbookId: null,
      metadata: {
        automationChainContext: {
          automationId: "auto-1",
          automationRunId: "run-0",
          chainDepth: 1,
          rootRunId: "run-0",
          // auto-2 is the automation about to match — already in the chain.
          chainAutomationIds: ["auto-1", "auto-2"],
        },
      },
    };

    await handleAutomationTriggerMatch({ data: { ...AGENT_EVENT } });

    expect(bossSend).not.toHaveBeenCalled();
  });

  it("without a stamped session context, treats the event as depth 0 (unchanged)", async () => {
    sessionRow = { playbookId: null, metadata: {} };

    await handleAutomationTriggerMatch({ data: { ...AGENT_EVENT } });

    // depth 0 → still fires; child run is depth 1.
    expect(bossSend).toHaveBeenCalledTimes(1);
    const [, payload] = bossSend.mock.calls[0] as [
      string,
      { automationContext: { chainDepth: number } },
    ];
    expect(payload.automationContext.chainDepth).toBe(1);
  });
});
