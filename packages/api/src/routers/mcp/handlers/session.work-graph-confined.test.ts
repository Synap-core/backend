/**
 * MCP `synap_get_work_graph` — a workspace-bound key is confined.
 *
 * The handler read the RAW `args.workspaceId` as its lens, so a key bound to
 * workspace W that sent none read the owner's pod-wide graph (rv-be-loop M3).
 * The adapter already resolves the one clamp (`resolveConfinedWorkspace`, a
 * mismatch 403s before any handler runs) into `ctx.confinedWorkspaceId`; the
 * handler now reads that, and keeps the far ends in the bound workspace.
 *
 * The ctx is built the way `adapter.ts` builds it, through the REAL
 * `resolveConfinedWorkspace`. Stubbed: `buildWorkGraph`, to record its input
 * (its WHERE and far-end clamp run for real in `work-graph.pglite.test.ts`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ inputs: [] as unknown[] }));

vi.mock("../../../services/focus-sessions/work-graph.js", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    buildWorkGraph: async (input: unknown) => {
      h.inputs.push(input);
      return { nodes: [], edges: [], sections: {}, window: {} };
    },
  };
});

import { sessionHandlers } from "./session.js";
import { resolveConfinedWorkspace } from "../../hub-protocol/confine-workspace.js";

const W = "11111111-1111-4111-8111-111111111111";

const call = (keyWorkspaceId: string | null, args: Record<string, unknown>) =>
  sessionHandlers.synap_get_work_graph!({
    toolName: "synap_get_work_graph",
    args,
    userId: "u1",
    apiKeyScopes: ["mcp.read"],
    keyType: "service",
    keyWorkspaceId,
    confinedWorkspaceId:
      resolveConfinedWorkspace(
        "service",
        keyWorkspaceId,
        typeof args.workspaceId === "string" ? args.workspaceId : undefined
      ) ?? undefined,
  } as never);

const inputOf = (i: unknown) =>
  i as { scope: { workspaceLens?: string }; boundWorkspaceId?: string };

describe("synap_get_work_graph — a workspace-bound key", () => {
  beforeEach(() => {
    h.inputs = [];
  });

  it("bound to W and naming no workspace ⇒ reads W, far ends kept in W", async () => {
    await call(W, {});
    expect(h.inputs).toHaveLength(1);
    expect(inputOf(h.inputs[0]).scope.workspaceLens).toBe(W);
    expect(inputOf(h.inputs[0]).boundWorkspaceId).toBe(W);
  });

  it("an unbound key keeps its own lens and no far-end clamp", async () => {
    await call(null, {});
    await call(null, { workspaceId: W });
    expect(inputOf(h.inputs[0]).scope.workspaceLens).toBeUndefined();
    expect(inputOf(h.inputs[1]).scope.workspaceLens).toBe(W);
    expect(
      h.inputs.every((i) => inputOf(i).boundWorkspaceId === undefined)
    ).toBe(true);
  });
});
