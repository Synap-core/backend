/**
 * The automation create/update DOOR refuses an AI fan-out over an unfiltered
 * query — the incident's flow (cron → query every company, no filter → loop →
 * an IS command per row) — and accepts it once filtered or `scope: "all"`.
 * Also: a malformed `maxAiDispatchesPerDay` is refused at the same door.
 *
 * Real: `automationsRouter.create` → `prepareAutomationForMaterialization`.
 * DB mocked: an INSERT reaching the mock proves the flow passed validation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetDb } = vi.hoisted(() => ({ mockGetDb: vi.fn() }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, getDb: mockGetDb };
});
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { automationsRouter } from "./automations.js";

function insertChain(captured: { values?: Record<string, unknown> }) {
  const chain = {
    values: vi.fn((v: Record<string, unknown>) => {
      captured.values = v;
      return chain;
    }),
    onConflictDoNothing: vi.fn(() => chain),
    returning: vi.fn().mockResolvedValue([{ id: "auto-1" }]),
  };
  return chain;
}

const caller = () =>
  automationsRouter.createCaller({
    authenticated: true,
    userId: "user-1",
  } as never);

/** cron → query(company) → loop → command (an IS task per row). */
function fanoutFlow(query: Record<string, unknown>) {
  return {
    nodes: [
      { id: "t", type: "trigger", data: { label: "Daily" } },
      {
        id: "q",
        type: "query",
        data: {
          label: "Companies",
          profileSlug: "company",
          limit: 100,
          ...query,
        },
      },
      {
        id: "l",
        type: "loop",
        data: {
          label: "Each",
          iteratorExpression: "steps.q.output.entities",
          itemVariable: "c",
        },
      },
      {
        id: "cmd",
        type: "command",
        data: { label: "Assess", commandId: "assess-company" },
      },
    ],
    edges: [
      { id: "e1", source: "t", target: "q" },
      { id: "e2", source: "q", target: "l" },
      { id: "e3", source: "l", target: "cmd" },
    ],
  };
}

async function create(
  flowDefinition: unknown,
  triggerConfig: Record<string, unknown> = { expression: "0 9 * * *" }
) {
  const captured: { values?: Record<string, unknown> } = {};
  mockGetDb.mockResolvedValue({ insert: vi.fn(() => insertChain(captured)) });
  const outcome = await caller()
    .create({
      name: "Assess every company",
      triggerType: "cron",
      triggerConfig,
      flowDefinition: flowDefinition as never,
      status: "draft",
    })
    .then(
      () => ({ inserted: captured.values !== undefined }),
      (e: { code?: string; message: string }) => ({
        code: e.code,
        message: e.message,
      })
    );
  return outcome;
}

describe("automations.create — AI fan-out needs a filter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses the incident's flow (empty filter) at the door, writing nothing", async () => {
    const outcome = await create(fanoutFlow({ filter: "" }));
    expect(outcome).toMatchObject({ code: "BAD_REQUEST" });
    expect((outcome as { message: string }).message).toContain("has no filter");
  });

  it("accepts the same flow with a filter", async () => {
    expect(await create(fanoutFlow({ filter: "stage = 'lead'" }))).toEqual({
      inserted: true,
    });
  });

  it('accepts the same flow with an explicit scope: "all"', async () => {
    expect(await create(fanoutFlow({ filter: "", scope: "all" }))).toEqual({
      inserted: true,
    });
  });

  it("refuses a malformed maxAiDispatchesPerDay", async () => {
    const outcome = await create(fanoutFlow({ filter: "x = 1" }), {
      expression: "0 9 * * *",
      maxAiDispatchesPerDay: 0,
    });
    expect(outcome).toMatchObject({ code: "BAD_REQUEST" });
    expect((outcome as { message: string }).message).toContain(
      "maxAiDispatchesPerDay"
    );
  });
});
