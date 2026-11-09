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
const addCreateTimeBlockers = vi.fn(async () => [
  { blockerSessionId: "sess-new", status: "linked" },
]);
const instantiateSession = vi.fn(async () => ({
  id: "sess-new",
  workspaceId: "ws-1",
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordSessionSpawn,
}));
vi.mock("../focus-sessions/session-blocked-by.js", () => ({
  addCreateTimeBlockers,
}));
// `resolveRunChoice` reads the person's stored run choice from the db before the
// session exists; the db is absent here, so answer "no stored choice".
vi.mock("../agent-dispatch/agent-assignment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readStoredRunChoice: async () => null,
}));
// …and routes the run to the playbook's assigned agent through the db: no
// assignment here.
vi.mock("../agent-dispatch/route.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  route: async () => ({ kind: "none" }),
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
    addCreateTimeBlockers.mockClear();
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

  it("a detour (suspendedIntent) records the intent and blocks the parent on the run's session", async () => {
    await runPlaybook({
      ...INPUT,
      parentSessionId: "parent-1",
      suspendedIntent: "ship the post once the playbook is done",
    }).catch(() => undefined);
    expect(recordSessionSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "parent-1",
        suspendedIntent: "ship the post once the playbook is done",
      })
    );
    expect(addCreateTimeBlockers).toHaveBeenCalledWith({
      sessionId: "parent-1",
      blockerSessionIds: ["sess-new"],
      userId: "owner-1",
    });
  });

  it("a slice (parent, no suspendedIntent) never blocks the parent", async () => {
    await runPlaybook({ ...INPUT, parentSessionId: "parent-1" }).catch(
      () => undefined
    );
    expect(addCreateTimeBlockers).not.toHaveBeenCalled();
  });
});
