/**
 * The `agentUsers.roster` SEAM (plan c727854c W5): the tRPC door answers with
 * THE presence read MCP `synap_list_agents` answers with
 * (`readAgentsForHandoff`), for the calling person, previewing hand-offs from
 * the calling agent when an agent key calls. A failed read throws, never an
 * empty roster.
 *
 * NOT covered here: the roster itself (`agents-for-handoff.pglite.test.ts`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "../context.js";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ userId: string; opts: unknown }>,
  fail: null as Error | null,
  roster: {
    agents: [{ agentUserId: "a1", name: "Claude Code", live: true }],
    computers: [
      { agentUserId: "m1", name: "MacBook", belongsTo: "person", agents: 1 },
    ],
  },
}));

vi.mock("../services/agent-dispatch/agents-for-handoff.js", () => ({
  readAgentsForHandoff: async (userId: string, opts: unknown) => {
    h.calls.push({ userId, opts });
    if (h.fail) throw h.fail;
    return h.roster;
  },
}));

import { agentUsersRouter } from "./agent-users.js";

const caller = (ctx: Record<string, unknown>) =>
  agentUsersRouter.createCaller({
    authenticated: true,
    ...ctx,
  } as unknown as Context);

beforeEach(() => {
  h.calls = [];
  h.fail = null;
});

describe("agentUsers.roster", () => {
  it("answers with the one presence read, for the person, hand-offs previewed as theirs", async () => {
    const out = await caller({ userId: "u1" }).roster();
    expect(out).toEqual(h.roster);
    expect(h.calls).toEqual([
      { userId: "u1", opts: { callerAgentUserId: null } },
    ]);
  });

  it("previews hand-offs from the calling agent when an agent key calls", async () => {
    await caller({ userId: "u1", agentUserId: "a9" }).roster();
    expect(h.calls).toEqual([
      { userId: "u1", opts: { callerAgentUserId: "a9" } },
    ]);
  });

  it("throws a failed read instead of an empty roster", async () => {
    h.fail = new Error("presence read failed");
    await expect(caller({ userId: "u1" }).roster()).rejects.toThrow(
      "presence read failed"
    );
  });
});
