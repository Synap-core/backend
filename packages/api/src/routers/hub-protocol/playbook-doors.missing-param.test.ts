/**
 * Seam test — the headless run door (MCP `synap_run_playbook`, Raycast, Hub
 * REST) decides where a missing required param goes from WHO launched the run
 * (founder decision E3, 2026-10-27): an AGENT gets it back as a refusal (the
 * spine's `PlaybookParamsError`, BAD_REQUEST from `playbooks.run`); a person's
 * own headless call still owes it as a slot on the run.
 *
 * Before, every call passed `"owe"`, so an agent's run with a hole filed
 * "Answer: <param>" in the founder's Needs you. What the spine does with each
 * value is pinned in `services/playbooks/playbook-params.test.ts`.
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

describe("runPlaybookDoor — a missing required param", () => {
  beforeEach(() => run.mockClear());

  it("an AGENT's run refuses it (back to the agent, never a person slot)", async () => {
    await runPlaybookDoor(
      { userId: "owner-1", scopes: ["write"], agentUserId: "agent-7" },
      { playbookId: "pb-1", source: "mcp" }
    );
    expect(run.mock.calls[0]![0]).toMatchObject({
      agentUserId: "agent-7",
      onMissingRequired: "refuse",
    });
  });

  it("CONTROL — a person's own headless run still owes it", async () => {
    await runPlaybookDoor(
      { userId: "owner-1", scopes: ["write"] },
      { playbookId: "pb-1", source: "raycast" }
    );
    expect(run.mock.calls[0]![0]).toMatchObject({ onMissingRequired: "owe" });
  });
});
