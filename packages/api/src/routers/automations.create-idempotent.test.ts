/**
 * Reuse-by-name idempotency for `automations.create` (0230).
 *
 * Re-authoring the same automation — MCP `synap_create_automation` on every
 * agent run, or a capability re-seeding "Enrich the lead" on each reconcile —
 * used to INSERT a second row (confirmed live: `Stellar Grant ×4`). The
 * automations_workspace_name_active_uq partial unique index now makes the second
 * insert a SQLSTATE 23505, and insertAutomationAfterGovernance must recover the
 * existing winner instead of throwing or cloning.
 *
 * DB is mocked: the insert throws 23505 and the recovery SELECT returns the
 * surviving row. The test asserts the create door RETURNS that existing id (so
 * the fix is not vacuous — a no-op recovery would return null/throw).
 */
import { describe, expect, it, vi } from "vitest";

const { mockGetDb } = vi.hoisted(() => ({ mockGetDb: vi.fn() }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, getDb: mockGetDb };
});

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { automationsRouter } from "./automations.js";

const FLOW = {
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

function callerCtx() {
  return { authenticated: true, userId: "user-1" } as never;
}

/** insert(...).values().onConflictDoNothing().returning() → throws a 23505. */
function throwingInsertChain() {
  const chain = {
    values: vi.fn(() => chain),
    onConflictDoNothing: vi.fn(() => chain),
    returning: vi.fn().mockRejectedValue({ code: "23505" }),
  };
  return chain;
}

/** select({id}).from().where().orderBy().limit() → the surviving winner. */
function selectWinnerChain(winnerId: string, spy: { where?: unknown }) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn((w: unknown) => {
      spy.where = w;
      return chain;
    }),
    orderBy: vi.fn(() => chain),
    limit: vi.fn().mockResolvedValue([{ id: winnerId }]),
  };
  return chain;
}

describe("automations.create — reuse-by-name on 23505 (0230)", () => {
  it("returns the existing automation id instead of cloning on a name collision", async () => {
    const existingId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const selectSpy: { where?: unknown } = {};
    mockGetDb.mockResolvedValue({
      insert: vi.fn(() => throwingInsertChain()),
      select: vi.fn(() => selectWinnerChain(existingId, selectSpy)),
    });

    const caller = automationsRouter.createCaller(callerCtx());
    const result = await caller.create({
      name: "Enrich the lead",
      triggerType: "manual",
      triggerConfig: {},
      flowDefinition: FLOW,
      status: "active",
    });

    // NOT vacuous: the recovery SELECT ran (its WHERE was built) and the door
    // surfaced the existing winner's id — no clone, no 500.
    expect(selectSpy.where).toBeDefined();
    expect(result.status).toBe("created");
    expect(result.id).toBe(existingId);
  });

  it("rethrows a 23505 when no surviving row can be recovered", async () => {
    const selectSpy: { where?: unknown } = {};
    mockGetDb.mockResolvedValue({
      insert: vi.fn(() => throwingInsertChain()),
      // Empty recovery — a genuine unique violation with nothing to reuse must
      // NOT be swallowed into a null success.
      select: vi.fn(() => {
        const chain = {
          from: vi.fn(() => chain),
          where: vi.fn((w: unknown) => {
            selectSpy.where = w;
            return chain;
          }),
          orderBy: vi.fn(() => chain),
          limit: vi.fn().mockResolvedValue([]),
        };
        return chain;
      }),
    });

    const caller = automationsRouter.createCaller(callerCtx());
    await expect(
      caller.create({
        name: "Enrich the lead",
        triggerType: "manual",
        triggerConfig: {},
        flowDefinition: FLOW,
        status: "active",
      })
    ).rejects.toBeDefined();
  });
});
