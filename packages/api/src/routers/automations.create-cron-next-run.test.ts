/**
 * Focused contract test for `automations.create`'s cron `nextRunAt` computation.
 *
 * The cron scheduler (packages/jobs/src/workers/automation-cron-scheduler.ts)
 * only selects automations WHERE status='active' AND nextRunAt <= now. So a cron
 * automation born `active` (a direct operator create, OR an agent-proposed create
 * materialized through the shared preparation path) MUST carry a non-null
 * `nextRunAt`, or it silently never fires. This test pins that:
 *   • create({status:'active', triggerType:'cron', triggerConfig:{expression}})
 *     inserts a NON-NULL nextRunAt (so the scheduler's WHERE would select it).
 *   • a non-cron active create leaves nextRunAt unset (only cron needs it).
 *
 * DB is mocked (no live Postgres in CI); assertions are on the values handed to
 * the INSERT, which is where nextRunAt is stamped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetDb } = vi.hoisted(() => ({ mockGetDb: vi.fn() }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, getDb: mockGetDb };
});

// The `create` mutation runs the read-only-guard middleware first, which calls
// isPodReadOnly() against the eager `db` singleton (real Postgres). No live PG in
// CI → stub it to "writable" so the test exercises create's own logic.
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import {
  automationsRouter,
  materializeApprovedAutomation,
} from "./automations.js";

/** insert(...).values(capturedValues).onConflictDoNothing().returning() → [{ id }] */
function insertChain(
  captured: { values?: Record<string, unknown> },
  rows: Array<{ id: string }> = [{ id: "auto-created-1" }]
) {
  const chain = {
    values: vi.fn((v: Record<string, unknown>) => {
      captured.values = v;
      return chain;
    }),
    onConflictDoNothing: vi.fn(() => chain),
    returning: vi.fn().mockResolvedValue(rows),
  };
  return chain;
}

function callerCtx() {
  return { authenticated: true, userId: "user-1" } as never;
}

const CRON_FLOW = {
  nodes: [
    {
      id: "n1",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: { triggerType: "manual", label: "Manual", config: {} },
    },
  ],
  edges: [],
};

describe("automations.create — cron nextRunAt", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stamps a non-null nextRunAt on an active cron automation", async () => {
    const captured: { values?: Record<string, unknown> } = {};
    mockGetDb.mockResolvedValue({ insert: vi.fn(() => insertChain(captured)) });

    const caller = automationsRouter.createCaller(callerCtx());
    const result = await caller.create({
      name: "Daily client recap",
      triggerType: "cron",
      // Every day at 09:00 — the `activate` proc reads triggerConfig.expression.
      triggerConfig: { expression: "0 9 * * *" },
      flowDefinition: CRON_FLOW,
      status: "active",
    });

    expect(result.status).toBe("created");
    // The scheduler filters on a non-null nextRunAt — assert one was stamped.
    const nextRunAt = captured.values?.nextRunAt;
    expect(nextRunAt).toBeInstanceOf(Date);
    // And it is in the FUTURE, so `nextRunAt <= now` becomes true at fire time.
    expect((nextRunAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it("leaves nextRunAt unset for a non-cron (event) active automation", async () => {
    const captured: { values?: Record<string, unknown> } = {};
    mockGetDb.mockResolvedValue({ insert: vi.fn(() => insertChain(captured)) });

    const caller = automationsRouter.createCaller(callerCtx());
    await caller.create({
      name: "On new person",
      triggerType: "event",
      triggerConfig: { eventPattern: "entity.create.completed" },
      flowDefinition: CRON_FLOW,
      status: "active",
    });

    expect(captured.values).toBeDefined();
    expect(captured.values?.nextRunAt).toBeUndefined();
  });

  it("leaves nextRunAt unset for a cron automation created as draft", async () => {
    const captured: { values?: Record<string, unknown> } = {};
    mockGetDb.mockResolvedValue({ insert: vi.fn(() => insertChain(captured)) });

    const caller = automationsRouter.createCaller(callerCtx());
    await caller.create({
      name: "Draft cron",
      triggerType: "cron",
      triggerConfig: { expression: "0 9 * * *" },
      flowDefinition: CRON_FLOW,
      status: "draft",
    });

    // Not active yet → not scheduled; `activate` will compute nextRunAt later.
    expect(captured.values?.nextRunAt).toBeUndefined();
  });

  it("converges a replayed proposal create on its pre-minted automation id", async () => {
    const captured: { values?: Record<string, unknown> } = {};
    const database = {
      insert: vi.fn(() => insertChain(captured, [])),
    };
    const proposedAutomationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    const result = await materializeApprovedAutomation({
      database: database as never,
      agentUserId: "agent-1",
      stableId: proposedAutomationId,
      definition: {
        name: "Governed automation",
        triggerType: "manual",
        triggerConfig: {},
        flowDefinition: CRON_FLOW,
        status: "draft",
        source: "ai",
        metadata: {
          dataContract: {
            version: 1,
            mode: "react",
            gets: [
              {
                id: "manual-input",
                label: "Manual request",
                origin: "manual",
                event: "Operator starts the automation",
                nodeIds: ["n1"],
              },
            ],
            stores: [],
            reacts: [
              {
                id: "run-process",
                label: "Run the process",
                kind: "process",
                nodeIds: ["n1"],
              },
            ],
          },
        },
      },
    });

    expect(captured.values?.id).toBe(proposedAutomationId);
    expect(captured.values?.createdBy).toBe("agent-1");
    expect(result).toBe(proposedAutomationId);
  });
});
