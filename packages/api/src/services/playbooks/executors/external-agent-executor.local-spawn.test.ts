/**
 * The no-webhook branch of the BYOA executor.
 *
 * Before it was wired this branch returned `{ status: "running" }` with a
 * "not yet implemented" summary — an undispatched run that nothing would ever
 * close. These tests pin the two honest outcomes instead: dispatched (running),
 * or failed WITH the reason. And they pin that the spawn is handed the run's
 * SESSION id, because that is what keys its checkout path.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("@synap/shared-utils", () => ({
  validateExternalUrl: () => ({ valid: true }),
  safeExternalFetch: vi.fn(async () => ({ ok: true })),
}));

const { ExternalAgentExecutor } = await import("./external-agent-executor.js");
const { registerDevAgentSpawner } = await import("./dev-agent-spawner.js");
type DispatchRequest = import("./dev-agent-spawner.js").DevAgentDispatchRequest;

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws-1",
    userId: "user-1",
    sessionId: "session-1",
    goal: "Fix the failing test",
    capabilities: [],
    ...overrides,
  } as never;
}

beforeEach(() => {
  // Reset the slot between tests (the registry is module-global).
  registerDevAgentSpawner(null);
});

describe("ExternalAgentExecutor — local spawn branch", () => {
  it("fails with the reason when no spawner is registered", async () => {
    const result = await new ExternalAgentExecutor().run(ctx());

    expect(result.status).toBe("failed");
    expect(result.error).toContain("registerDevAgentSpawner");
  });

  it("dispatches the run to the registered spawner, keyed on the SESSION", async () => {
    const seen: DispatchRequest[] = [];
    registerDevAgentSpawner(async (req) => {
      seen.push(req);
      return { pid: 4242, cwd: "/repos/wt-session-1" };
    });

    const result = await new ExternalAgentExecutor().run(
      ctx({
        input: { runId: "run-9" },
        subjectId: "ent-1",
        subjectName: "Acme",
      })
    );

    expect(result.status).toBe("running");
    expect(result.summary).toContain("4242");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sessionId).toBe("session-1");
    expect(seen[0]?.runId).toBe("run-9");
    expect(seen[0]?.subject).toEqual({
      id: "ent-1",
      name: "Acme",
      profile: null,
    });
  });

  it("fails the run when the spawn itself throws", async () => {
    registerDevAgentSpawner(async () => {
      throw new Error("local dev agent is not enabled for this workspace");
    });

    const result = await new ExternalAgentExecutor().run(ctx());

    expect(result.status).toBe("failed");
    expect(result.error).toContain("not enabled for this workspace");
  });

  it("still prefers the webhook path when a webhookUrl is present", async () => {
    let spawned = false;
    registerDevAgentSpawner(async () => {
      spawned = true;
      return { pid: 1, cwd: "/" };
    });

    const result = await new ExternalAgentExecutor().run(
      ctx({ input: { webhookUrl: "https://agent.example.com/hook" } })
    );

    expect(result.status).toBe("running");
    expect(result.summary).toContain("webhook");
    expect(spawned).toBe(false);
  });
});
