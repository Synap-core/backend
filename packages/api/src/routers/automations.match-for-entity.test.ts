/**
 * `automations.matchForEntity` — the capture router's automation half — reads
 * candidates through the access layer and DECIDES with the trigger matcher's
 * own `automationTriggerMatches` (one predicate; see
 * `services/routing/match-rules-for-entity.test.ts` for the predicate's
 * discriminating fixtures). This file pins the DOOR: access scoping, the
 * propose-only rule, and the card shape the intake-ui hook reads.
 *
 * DB is mocked at `getDb` (no live Postgres); the decision runs for real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const predicate = vi.fn(() => ({ __visibility: true }));
  return {
    predicate,
    scopedDb: vi.fn(() => ({ predicate })),
    accessFrom: vi.fn((ctx: unknown) => ({ __access: ctx })),
    getDb: vi.fn(),
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, getDb: h.getDb };
});
vi.mock("../access/index.js", () => ({
  AccessContext: { from: h.accessFrom },
  scopedDb: h.scopedDb,
}));

import { automationsRouter } from "./automations.js";

const WORKSPACE = "00000000-0000-4000-8000-000000000010";
const PB = "33333333-3333-4333-8333-333333333333";

const flow = (mode?: "propose") => ({
  nodes: [
    { id: "t", type: "trigger", data: {} },
    {
      id: "p",
      type: "playbook_run",
      data: { label: "x", playbookId: PB, ...(mode ? { mode } : {}) },
    },
  ],
  edges: [],
});

function dbReturning(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.orderBy = () => Promise.resolve(rows);
  return { select: vi.fn(() => chain) };
}

const caller = () =>
  automationsRouter.createCaller({
    authenticated: true,
    userId: "user-1",
    workspaceId: WORKSPACE,
  } as never);

describe("automations.matchForEntity — propose rules, the matcher's predicate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the propose rule a capture of this kind fires, as a card; never an auto rule", async () => {
    h.getDb.mockResolvedValue(
      dbReturning([
        {
          id: "rule-propose",
          name: "Qualify new people",
          description: "Asks before qualifying",
          triggerConfig: {
            eventPattern: "entity.create.completed",
            filters: { profileSlug: "person" },
          },
          flowDefinition: flow("propose"),
        },
        {
          id: "rule-auto",
          name: "Enrich new people",
          description: null,
          triggerConfig: {
            eventPattern: "entity.create.completed",
            filters: { profileSlug: "person" },
          },
          flowDefinition: flow(),
        },
      ])
    );

    const result = await caller().matchForEntity({
      profileSlug: "person",
      workspaceId: WORKSPACE,
    });

    expect(result).toEqual([
      {
        id: "rule-propose",
        name: "Qualify new people",
        description: "Asks before qualifying",
        triggerSummary: "On person created",
        proposes: true,
        score: 2,
        reason: "Made for person items",
        signals: [{ type: "kind", profileSlug: "person" }],
      },
    ]);
    // Access scoping, exactly like `list`.
    expect(h.accessFrom).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", workspaceId: WORKSPACE })
    );
    expect(h.predicate).toHaveBeenCalledTimes(1);
  });

  it("an operator kind filter matches (the old SQL equality never did)", async () => {
    h.getDb.mockResolvedValue(
      dbReturning([
        {
          id: "rule-in",
          name: "Leads and deals",
          description: null,
          triggerConfig: {
            eventPattern: "entity.create.completed",
            filters: { profileSlug: { $in: ["deal", "lead"] } },
          },
          flowDefinition: flow("propose"),
        },
      ])
    );
    const result = await caller().matchForEntity({
      profileSlug: "lead",
      workspaceId: WORKSPACE,
      intentText: "leads and deals",
    });
    expect(result.map((r) => r.id)).toEqual(["rule-in"]);
  });
});
