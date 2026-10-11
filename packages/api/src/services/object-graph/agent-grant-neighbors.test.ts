/**
 * A grant's agent neighbour is addressed by its agent USER id — the holder key
 * a "What it can do" page opens by — never the `agents` catalog id. Driven
 * through `getGovernanceNeighbors` on a faked `getDb()` answering per table.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  queues: new Map<unknown, Record<string, unknown>[][]>(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = (rows: Record<string, unknown>[]) => {
    const self: Record<string, unknown> = {
      where: () => self,
      limit: () => self,
      orderBy: () => self,
      then: (
        resolve: (v: Record<string, unknown>[]) => unknown,
        reject?: (e: unknown) => unknown
      ) => Promise.resolve(rows).then(resolve, reject),
    };
    return self;
  };
  const fakeDb = {
    select: () => ({
      from: (table: unknown) => chain(h.queues.get(table)?.shift() ?? []),
    }),
  };
  return { ...actual, getDb: async () => fakeDb };
});

import * as schema from "@synap/database";
import { getGovernanceNeighbors } from "./graph-service.js";

const USER = "user-owner";
const TOOL = "11111111-1111-4111-8111-111111111111";
const CATALOG_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_USER = "agent-user-1";

beforeEach(() => {
  h.queues = new Map();
});

describe("grant → agent neighbour", () => {
  it("is keyed on the agent USER id, not the agents catalog id", async () => {
    h.queues.set(schema.vaultGrants, [
      [{ grantedTo: AGENT_USER, workspaceId: null }],
    ]);
    h.queues.set(schema.agents, [
      [{ id: CATALOG_ID, userId: AGENT_USER, name: "Claude Code" }],
    ]);
    const out = await getGovernanceNeighbors(
      USER,
      "tool",
      TOOL,
      {} as never,
      null
    );
    const agent = out.find((n) => n.kind === "agent");
    expect(agent).toBeDefined();
    expect(agent!.id).toBe(AGENT_USER);
    expect(agent!.id).not.toBe(CATALOG_ID);
    expect(agent!.name).toBe("Claude Code");
  });
});
