/**
 * MCP `synap_get_work_graph` — the playbook and subject narrows reach the
 * service, and the LEAN node carries where a node stands on its method.
 *
 * Stubbed: `buildWorkGraph`, to record its input and hand back one node built
 * the way the service builds it (its WHERE and projections run for real in
 * `work-graph.pglite.test.ts`). What this pins is the handler's own seam: the
 * args it forwards and the lean map it applies.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const PLAYBOOK = "22222222-2222-4222-8222-222222222222";
const THING = "33333333-3333-4333-8333-333333333333";
const TRACK = "44444444-4444-4444-8444-444444444444";

const h = vi.hoisted(() => ({ inputs: [] as unknown[] }));

vi.mock("../../../services/focus-sessions/work-graph.js", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    buildWorkGraph: async (input: unknown) => {
      h.inputs.push(input);
      return {
        nodes: [
          {
            id: "s1",
            title: "A run",
            status: "active",
            kind: "run",
            parentSessionId: null,
            trackId: TRACK,
            trackStage: "build",
            playbookId: PLAYBOOK,
            currentStage: "review",
            stages: [
              { key: "draft", name: "Draft" },
              { key: "review", name: "Review it" },
            ],
            playbookMatch: "session",
            projectId: null,
            workspaceId: null,
            updatedAt: "2026-11-17T00:00:00.000Z",
            inWindow: true,
            nextMove: { kind: "wait", actor: "agent", label: "Working" },
          },
          {
            id: "s2",
            title: "No stage",
            status: "active",
            kind: "work",
            parentSessionId: null,
            trackId: null,
            trackStage: null,
            playbookId: null,
            currentStage: null,
            stages: [],
            playbookMatch: null,
            projectId: null,
            workspaceId: null,
            updatedAt: "2026-11-17T00:00:00.000Z",
            inWindow: true,
            nextMove: { kind: "wait", actor: "agent", label: "Working" },
          },
        ],
        edges: [],
        pullRequests: [],
        holds: [],
        goals: [],
        sections: {},
        window: {},
      };
    },
  };
});

import { sessionHandlers } from "./session.js";

const call = (args: Record<string, unknown>) =>
  sessionHandlers.synap_get_work_graph!({
    toolName: "synap_get_work_graph",
    args,
    userId: "u1",
    apiKeyScopes: ["mcp.read"],
    keyType: "service",
    keyWorkspaceId: null,
    confinedWorkspaceId: undefined,
  } as never);

const body = (r: Awaited<ReturnType<typeof call>>) =>
  JSON.parse((r.content[0] as { text: string }).text) as {
    nodes?: Array<Record<string, unknown>>;
    error?: string;
  };

describe("synap_get_work_graph — by playbook and by thing", () => {
  beforeEach(() => {
    h.inputs = [];
  });

  it("forwards the playbook and subject narrows to the service", async () => {
    await call({ playbookId: PLAYBOOK, subjectEntityId: THING });
    expect(h.inputs).toHaveLength(1);
    expect(h.inputs[0]).toMatchObject({
      playbookId: PLAYBOOK,
      subjectEntityId: THING,
    });
  });

  it("passes no narrow when none is asked", async () => {
    await call({});
    const input = h.inputs[0] as Record<string, unknown>;
    expect(input.playbookId).toBeUndefined();
    expect(input.subjectEntityId).toBeUndefined();
  });

  it("answers a malformed id with the error, and reads nothing", async () => {
    const r = body(await call({ playbookId: "nope" }));
    expect(r.error).toMatch(/playbookId is not a valid id/);
    const s = body(await call({ subjectEntityId: "nope" }));
    expect(s.error).toMatch(/subjectEntityId is not a valid id/);
    expect(h.inputs).toHaveLength(0);
  });

  it("a lean node says where it stands on its method", async () => {
    const r = body(await call({ playbookId: PLAYBOOK }));
    expect(r.nodes?.[0]).toMatchObject({
      playbookId: PLAYBOOK,
      currentStage: "review",
      currentStageName: "Review it",
      playbookMatch: "session",
      trackId: TRACK,
      trackStage: "build",
    });
    // Lean stays lean: the stage snapshot itself is not shipped.
    expect(r.nodes?.[0]).not.toHaveProperty("stages");
    expect(r.nodes?.[1]).toMatchObject({
      playbookId: null,
      currentStage: null,
      currentStageName: null,
      playbookMatch: null,
    });
  });
});
