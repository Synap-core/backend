import { describe, it, expect, vi, beforeEach } from "vitest";
/**
 * LEAN RUN TOOLS (founder, 2026-11-05) — the `is-agent` kickoff names the
 * run's declared tools on the turn it dispatches, so the IS sends the run core
 * tools plus only the capabilities the playbook and its space declare.
 *
 * Before: the kickoff carried no run profile, and run 9d57a207 (Package ideas)
 * got the universal agent's 50 tools on every call (finding 3fb5dae8).
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
vi.mock("@synap/database/schema", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database/schema")>()),
  MessageAuthorType: { HUMAN: "human" },
  MessageRole: { USER: "user" },
}));
vi.mock("@synap-core/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap-core/core")>()),
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {} }),
}));
vi.mock("../../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: (...args: unknown[]) =>
    (triggerAutoRespond as any)(...args),
}));
const resolveRunToolProfile = vi.fn(async (p: { playbookId: string }) => ({
  playbookId: p.playbookId,
  playbookName: "Package ideas",
  intents: ["generate_media"],
  verbs: ["fal_generate_image"],
  capabilitiesRead: "ok" as const,
}));
vi.mock("../run-tool-profile.js", () => ({
  resolveRunToolProfile: (...args: unknown[]) =>
    (resolveRunToolProfile as any)(...args),
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
  goal: "Package the idea bank of this space.",
  capabilities: [],
};

describe("is-agent executor — the run's declared tools ride on the kickoff", () => {
  beforeEach(() => {
    triggerAutoRespond.mockClear();
    resolveRunToolProfile.mockClear();
  });

  it("a playbook run ⇒ the kickoff turn carries its run profile", async () => {
    const res = await new IsAgentExecutor().run({
      ...baseCtx,
      playbookId: "pb-package-ideas",
    } as any);
    expect(res.status).toBe("running");
    expect(resolveRunToolProfile).toHaveBeenCalledWith({
      playbookId: "pb-package-ideas",
      workspaceId: "ws-1",
      userId: "user-1",
      sessionId: "sess-1",
    });
    expect(triggerAutoRespond.mock.calls[0][0]).toMatchObject({
      run: {
        playbookId: "pb-package-ideas",
        verbs: ["fal_generate_image"],
        capabilitiesRead: "ok",
      },
    });
  });

  it("no playbook ⇒ no run profile (nothing declares tools)", async () => {
    await new IsAgentExecutor().run(baseCtx as any);
    expect(resolveRunToolProfile).not.toHaveBeenCalled();
    expect(
      (triggerAutoRespond.mock.calls[0][0] as { run?: unknown }).run
    ).toBeUndefined();
  });
});
