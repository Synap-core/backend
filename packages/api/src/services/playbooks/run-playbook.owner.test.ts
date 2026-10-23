/**
 * Who OWNS a run's session: always the PERSON (`userId`). Agents named in
 * `agentIds` sit on the roster. An APPROVED run (the executor passes no
 * `agentUserId`, `executors/playbook.ts` OWNERSHIP) is accepted by that
 * approval. A run an agent starts DIRECTLY (`agentUserId`, no proposal) is the
 * person's too, with the starter first on the roster, and waits as a triage
 * draft (`origin: "agent"`) — B6 2026-10-21. It used to be owned by the agent
 * user, invisible to the person (session reads are owner-only). Asserted on the
 * row `instantiateSession` is asked to create — the real spine up to that call.
 */

import { describe, it, expect, vi } from "vitest";

const instantiateSession = vi.fn(async (_input: Record<string, unknown>) => {
  throw new Error("REACHED_SESSION_CREATION");
});

vi.mock("./playbook-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveRunnablePlaybook: async () => ({
    id: "pb-1",
    name: "Produce Content",
    goalTemplate: "Produce the post",
    inputStrategy: { kind: "none" },
    metadata: {},
  }),
  instantiateSession,
}));

const { runPlaybook } = await import("./run-playbook.js");

describe("runPlaybook — session owner", () => {
  it("no agentUserId → the person owns the session; agentIds are its roster", async () => {
    await expect(
      runPlaybook({
        playbookId: "pb-1",
        workspaceId: "ws-1",
        userId: "person-1",
        agentIds: ["agent-asker"],
      })
    ).rejects.toThrow("REACHED_SESSION_CREATION");
    expect(instantiateSession.mock.calls[0]![0]).toMatchObject({
      userId: "person-1",
      agentIds: ["agent-asker"],
    });
  });

  it("a DIRECT agent run → the person owns it, the starter leads the roster, and it is a draft", async () => {
    instantiateSession.mockClear();
    await expect(
      runPlaybook({
        playbookId: "pb-1",
        workspaceId: "ws-1",
        userId: "person-1",
        agentUserId: "agent-starter",
        agentIds: ["agent-extra", "agent-starter"],
      })
    ).rejects.toThrow("REACHED_SESSION_CREATION");
    expect(instantiateSession.mock.calls[0]![0]).toMatchObject({
      userId: "person-1",
      agentIds: ["agent-starter", "agent-extra"],
      origin: "agent",
    });
  });

  it("CONTROL — a run nobody's agent started is not a draft (no origin override)", async () => {
    instantiateSession.mockClear();
    await expect(
      runPlaybook({
        playbookId: "pb-1",
        workspaceId: "ws-1",
        userId: "person-1",
      })
    ).rejects.toThrow("REACHED_SESSION_CREATION");
    expect(instantiateSession.mock.calls[0]![0]).not.toHaveProperty("origin");
  });
});
