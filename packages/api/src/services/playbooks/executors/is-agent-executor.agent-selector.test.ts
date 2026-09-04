import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * AGENT SELECTOR — the `is-agent` executor's dispatch contract.
 *
 * Before this, the executor called `triggerAutoRespond` with no `agentType`, so
 * EVERY playbook dispatch landed on the default orchestrator ("meta") and no
 * caller could target a named persona. The three cases pinned here are the whole
 * contract, and the middle one is the one that matters most: an unknown selector
 * must FAIL the run. A silent fall back to "meta" would show the user a run that
 * "worked" while a different agent answered it.
 */

const triggerAutoRespond = vi.fn(
  async (_params: { agentType?: string | null }) => true
);
const resolveActiveAgentBySlug = vi.fn(
  async (_slug: string): Promise<{ slug: string } | null> => null
);
const insertChannelMessage = vi.fn(async () => ({ messageId: "msg-1" }));

// The context-skill lookup resolves to [] (no "how to run this playbook" prefix).
const db = {
  select: () => ({
    from: () => ({
      innerJoin: () => ({
        where: () => ({ orderBy: () => ({ limit: async () => [] }) }),
      }),
    }),
  }),
};

// PARTIAL mock (`importOriginal`), not a hand-listed replacement: a total mock
// dies at COLLECTION time the moment the executor's import graph reaches an
// export the object does not list, and the whole file goes dark silently. Only
// the two things this test fakes are overridden; real tables and operators come
// from the module. `@synap/database`'s clients are lazy-connect, so importing it
// opens no socket. See `__tripwires__/database-mock-total-ratchet.test.ts`.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: async () => db,
    insertChannelMessage: (...args: unknown[]) =>
      (insertChannelMessage as any)(...args),
  };
});
vi.mock("@synap/database/schema", () => ({
  MessageAuthorType: { HUMAN: "human" },
  MessageRole: { USER: "user" },
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {} }),
}));
vi.mock("../../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: (...args: unknown[]) =>
    (triggerAutoRespond as any)(...args),
}));
vi.mock("../../agent-identity-service.js", () => ({
  resolveActiveAgentBySlug: (...args: unknown[]) =>
    (resolveActiveAgentBySlug as any)(...args),
}));

const { IsAgentExecutor } = await import("./is-agent-executor.js");

const baseCtx = {
  workspaceId: "ws-1",
  userId: "user-1",
  sessionId: "sess-1",
  channelId: "chan-1",
  goal: "do the thing",
  capabilities: [],
};

describe("is-agent executor — agent selector", () => {
  beforeEach(() => {
    triggerAutoRespond.mockClear();
    insertChannelMessage.mockClear();
    resolveActiveAgentBySlug.mockReset();
    resolveActiveAgentBySlug.mockResolvedValue(null);
  });

  it("no selector ⇒ dispatches with agentType null (the door's own 'meta' default)", async () => {
    const res = await new IsAgentExecutor().run(baseCtx as any);
    expect(res.status).toBe("running");
    expect(resolveActiveAgentBySlug).not.toHaveBeenCalled();
    expect(triggerAutoRespond).toHaveBeenCalledTimes(1);
    expect(triggerAutoRespond.mock.calls[0][0]).toMatchObject({
      agentType: null,
    });
  });

  it("known selector ⇒ forwards the resolved slug to triggerAutoRespond", async () => {
    resolveActiveAgentBySlug.mockResolvedValue({ slug: "persona:cto" });
    const res = await new IsAgentExecutor().run({
      ...baseCtx,
      agentType: " persona:cto ",
    } as any);
    expect(res.status).toBe("running");
    expect(resolveActiveAgentBySlug).toHaveBeenCalledWith("persona:cto");
    expect(triggerAutoRespond.mock.calls[0][0]).toMatchObject({
      agentType: "persona:cto",
    });
  });

  it("unknown selector ⇒ FAILS the run; never dispatches, never posts a kickoff", async () => {
    resolveActiveAgentBySlug.mockResolvedValue(null);
    const res = await new IsAgentExecutor().run({
      ...baseCtx,
      agentType: "no-such-agent",
    } as any);
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/unknown agent "no-such-agent"/);
    // The two things a silent fallback would have done:
    expect(triggerAutoRespond).not.toHaveBeenCalled();
    expect(insertChannelMessage).not.toHaveBeenCalled();
  });
});
