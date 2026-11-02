/**
 * METHOD ON BIND — the MCP doors that bind a playbook hand the agent its
 * method in the same reply, through the ONE loader/renderer the IS executor's
 * kickoff uses (`services/playbooks/playbook-method.ts`).
 *
 * Driven through the real handlers. Stubbed at their module seams: the two
 * services (`createFocusSession`, `updateFocusSession`: governance and a
 * database), the nudge loader and offer stamp, and `loadBoundPlaybookMethod`
 * (its DB read; the text it renders is pinned in `playbook-method.test.ts`).
 * What is under test is that each binding reaches the loader with the
 * session's playbook and stage, and that its answer rides the reply.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  loadMethod: vi.fn(),
}));

vi.mock("../../../services/focus-sessions/create-session.js", () => ({
  createFocusSession: h.create,
}));
vi.mock("../../../services/focus-sessions/update-session.js", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, updateFocusSession: h.update };
});
vi.mock("../../../services/focus-sessions/session-nudges.js", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    loadSessionNudges: async () => null,
    claimPlaybookOffer: async () => true,
  };
});
vi.mock("../../../services/playbooks/playbook-method.js", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, loadBoundPlaybookMethod: h.loadMethod };
});

import { sessionHandlers } from "./session.js";
import type { McpToolContext } from "./shared.js";

const PB = "44444444-4444-4444-8444-444444444444";
const SID = "11111111-2222-4333-8444-555555555555";
const STAGES = [{ key: "draft", name: "Draft", goal: "Write it." }];
const METHOD = {
  status: "ok",
  playbookId: PB,
  playbookName: "Write a brief",
  stageKey: "draft",
  text: "## How to run this playbook\nRead the brief first.\n\n## Current stage: Draft\nWrite it.",
};

function ctx(toolName: string, args: Record<string, unknown>): McpToolContext {
  return {
    toolName,
    args,
    userId: "11111111-1111-4111-8111-111111111111",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: "22222222-2222-4222-8222-222222222222",
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: true,
  };
}

const body = (r: { content?: unknown[] }) =>
  JSON.parse((r.content![0] as { text: string }).text) as Record<
    string,
    unknown
  >;

beforeEach(() => {
  h.create.mockReset();
  h.update.mockReset();
  h.loadMethod.mockReset();
  h.loadMethod.mockResolvedValue(METHOD);
});

describe("synap_start_session with templateId", () => {
  it("returns the playbook's method, for the session's own stage snapshot", async () => {
    h.create.mockResolvedValue({
      status: "created",
      session: {
        id: SID,
        title: null,
        metadata: {},
        playbookId: PB,
        currentStage: "draft",
        stages: STAGES,
      },
    });
    const r = body(
      await sessionHandlers.synap_start_session!(
        ctx("synap_start_session", { goal: "Write the brief", templateId: PB })
      )
    );
    expect(h.loadMethod).toHaveBeenCalledWith({
      playbookId: PB,
      stageKey: "draft",
      stages: STAGES,
    });
    expect(r.method).toEqual(METHOD);
  });

  it("CONTROL — an unbound session carries no method and reads nothing", async () => {
    h.create.mockResolvedValue({
      status: "created",
      session: { id: SID, title: null, metadata: {}, playbookId: null },
    });
    const r = body(
      await sessionHandlers.synap_start_session!(
        ctx("synap_start_session", { goal: "Ad hoc", templateId: null })
      )
    );
    expect(h.loadMethod).not.toHaveBeenCalled();
    expect("method" in r).toBe(false);
  });
});

describe("synap_update_session with followPlaybookId", () => {
  const followed = (follow: Record<string, unknown> | undefined) => ({
    status: "updated",
    session: {
      id: SID,
      userId: "u1",
      workspaceId: null,
      title: "Brief",
      goal: "Write the brief",
      status: "active",
      playbookId: PB,
      currentStage: null,
      stages: [],
      expectedOutputs: [],
      criteria: [],
      metadata: {},
    },
    ...(follow ? { follow } : {}),
  });

  it("an attach returns the method (no stage named ⇒ stageKey null)", async () => {
    h.update.mockResolvedValue(
      followed({ action: "attached", playbookId: PB, stageKey: null })
    );
    const r = body(
      await sessionHandlers.synap_update_session!(
        ctx("synap_update_session", { sessionId: SID, followPlaybookId: PB })
      )
    );
    expect(r.status).toBe("updated");
    expect(h.loadMethod).toHaveBeenCalledWith({
      playbookId: PB,
      stageKey: null,
      stages: [],
    });
    expect(r.method).toEqual(METHOD);
  });

  it("CONTROL — a release, or an update with no follow, carries no method", async () => {
    h.update.mockResolvedValue(
      followed({ action: "detached", playbookId: null, stageKey: null })
    );
    const released = body(
      await sessionHandlers.synap_update_session!(
        ctx("synap_update_session", { sessionId: SID, followPlaybookId: null })
      )
    );
    expect("method" in released).toBe(false);

    h.update.mockResolvedValue(followed(undefined));
    const plain = body(
      await sessionHandlers.synap_update_session!(
        ctx("synap_update_session", { sessionId: SID, progress: 10 })
      )
    );
    expect("method" in plain).toBe(false);
    expect(h.loadMethod).not.toHaveBeenCalled();
  });
});
