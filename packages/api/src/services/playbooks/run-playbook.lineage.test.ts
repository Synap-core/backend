/**
 * Seam test — a playbook run started FROM a session records its lineage
 * (`run session --spawned_from--> parent`) through the one producer,
 * `recordSessionSpawn`, right after the run's session exists.
 *
 * The owner floor is the HUMAN principal (`userId`), never the acting agent:
 * an agent-started run's session is owned by the agent user, while the session
 * the agent was working in belongs to the person. Passing `actorId` would make
 * the producer's owner check refuse every agent-started run's parent.
 *
 * NOT covered here: everything after the lineage call (channel, run row) — the
 * mocked `db` is absent, so the run rejects past this point, which is why the
 * assertions read the producer call rather than `parentLink` on the result.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const recordSessionSpawn = vi.fn(async () => ({
  linked: true as const,
  suspendedIntentRecorded: false,
}));
const instantiateSession = vi.fn(async () => ({
  id: "sess-new",
  workspaceId: "ws-1",
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordSessionSpawn,
}));
vi.mock("./playbook-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveRunnablePlaybook: async () => ({
    id: "pb-1",
    name: "Research a Question",
    goalTemplate: "Research it",
    inputStrategy: { kind: "none" },
    metadata: {},
  }),
  instantiateSession,
}));

const { runPlaybook } = await import("./run-playbook.js");

const INPUT = {
  playbookId: "pb-1",
  workspaceId: "ws-1",
  userId: "owner-1",
  agentUserId: "agent-7",
};

describe("runPlaybook — lineage", () => {
  beforeEach(() => {
    recordSessionSpawn.mockClear();
    instantiateSession.mockClear();
  });

  it("records the new run session as spawned from the session it was started from, floored on the HUMAN owner", async () => {
    await runPlaybook({ ...INPUT, parentSessionId: "parent-1" }).catch(
      () => undefined
    );
    expect(instantiateSession).toHaveBeenCalledOnce();
    expect(recordSessionSpawn).toHaveBeenCalledWith({
      childSessionId: "sess-new",
      parentSessionId: "parent-1",
      userId: "owner-1",
      workspaceId: "ws-1",
    });
  });

  it("writes no edge when the run was not started from a session", async () => {
    await runPlaybook(INPUT).catch(() => undefined);
    expect(instantiateSession).toHaveBeenCalledOnce();
    expect(recordSessionSpawn).not.toHaveBeenCalled();
  });
});
