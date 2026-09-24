/**
 * Seam test — the headless run door (MCP `synap_run_playbook`, Raycast, Hub
 * REST all call `runPlaybookDoor`) hands the caller's bound session to
 * `playbooks.run` as `parentSessionId`, so a run an agent starts from inside
 * its session lands spawned FROM that session. Without a bound session no
 * parent is passed — never a guess.
 *
 * The router is mocked at `createCaller`; what `run` does with the parent is
 * pinned separately (`services/playbooks/run-playbook.lineage.test.ts`).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const run = vi.fn(async (_input: Record<string, unknown>) => ({
  run: null,
  session: null,
  status: "running",
  message: "ok",
  proposalId: null,
}));

vi.mock("../playbooks.js", () => ({
  playbooksRouter: { createCaller: () => ({ run }) },
}));
vi.mock("./utils.js", () => ({
  createHubProtocolCallerContext: async () => ({}),
}));
vi.mock("../../services/playbooks/resolve-playbook-name.js", () => ({
  resolvePlaybookByIdVisible: async () => ({ id: "pb-1", workspaceId: "ws-1" }),
  resolvePlaybookByPublicName: async () => ({ status: "not_found" }),
  resolvePlaybookRunWriteWorkspace: () => "ws-1",
}));

const { runPlaybookDoor } = await import("./playbook-doors.js");

const IDENTITY = {
  userId: "owner-1",
  scopes: ["write"],
  agentUserId: "agent-7",
};

describe("runPlaybookDoor — lineage", () => {
  beforeEach(() => run.mockClear());

  it("passes the caller's bound session as the run's parent", async () => {
    await runPlaybookDoor(
      { ...IDENTITY, sessionId: "sess-a" },
      { playbookId: "pb-1", source: "mcp" }
    );
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ parentSessionId: "sess-a" })
    );
  });

  it("passes no parent when the caller has no bound session", async () => {
    await runPlaybookDoor(IDENTITY, { playbookId: "pb-1", source: "mcp" });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0]).not.toHaveProperty("parentSessionId");
  });
});
