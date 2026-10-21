/**
 * Who OWNS a run's session. `runPlaybook` gives the session to the agent user
 * when `agentUserId` is passed, else to the person (`userId`); agents named in
 * `agentIds` sit on the roster. The approval executor relies on the second
 * branch: an approved run is the person's, with the asking agent on the roster
 * (`executors/playbook.ts`, OWNERSHIP). Asserted on the row `instantiateSession`
 * is asked to create — the real spine up to that call.
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
});
