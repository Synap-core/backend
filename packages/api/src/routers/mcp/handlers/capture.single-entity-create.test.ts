/**
 * ONE CAPTURED ENTITY IS A TYPED CREATE, NOT AN `import.graph`.
 *
 * Founder, 2026-11-16: "AI is making too much import requests, but normally the
 * proposal should be directly an entity". `synap_capture({ entities: [one] })`
 * filed every structured payload through `submitCaptureGraph` (an
 * `import.graph` proposal); a single decision read as an import request in the
 * review queue.
 *
 * Driven through the real handler. The typed door (`createEntityData`) and the
 * graph core (`submitCaptureGraph`) are spies, so each test asserts WHICH door
 * the payload reached: that is the behaviour, and the receipt fields a caller
 * reads (`status`, `proposalId`, `reviewUrl`, `writeReceipt`, `entityIds`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  graphs: [] as Array<Record<string, unknown>>,
  createResult: {} as Record<string, unknown>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    resolveProjectPlacement: async () => ({ projectId: null, rung: null }),
    resolveIdentity: async () => ({
      match: "none",
      candidates: [],
      crossKindCandidates: [],
    }),
  };
});

vi.mock("./entity.js", () => ({
  createEntityData: async (ctx: { args: Record<string, unknown> }) => {
    h.created.push(ctx.args);
    return h.createResult;
  },
}));

vi.mock("../../../services/capture-agent/stored-capture-scope.js", () => ({
  readStoredProposalScope: async () => ({
    status: "read",
    scope: { workspaceId: "ws-1", projectId: "proj-1", sessionId: "sess-1" },
  }),
}));

vi.mock("../../../services/intake/ensure-intake-session.js", () => ({
  ensureIntakeSession: async () => ({
    sessionId: null,
    status: "none",
    requestedSessionIgnored: false,
  }),
}));
vi.mock("../../../services/intake/record-structure-intake.js", () => ({
  recordStructureIntake: async () => ({
    intake: { status: "none", sourceDocumentIds: [] },
  }),
}));

vi.mock("../../../services/capture-agent/submit-capture-graph.js", () => ({
  dryRunCaptureGraph: async () => {
    throw new Error("not a dry run");
  },
  submitCaptureGraph: async (input: Record<string, unknown>) => {
    h.graphs.push(input);
    return {
      proposalId: "graph-proposal",
      entityCount: (input.entities as unknown[]).length,
      relationCount: 0,
      applied: false,
      scope: { workspaceId: null, projectId: null, sessionId: null },
      writeReceipt: { state: "pending", proposalId: "graph-proposal" },
    };
  },
}));

import { captureHandlers } from "./capture.js";
import type { McpToolContext } from "./shared.js";

function ctx(args: Record<string, unknown>): McpToolContext {
  return {
    toolName: "synap_capture",
    args,
    userId: "user-owner",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    workspaceAccessible: true,
  } as unknown as McpToolContext;
}

type Result = { content: Array<{ text?: string }> };
const payload = (r: Result) => JSON.parse(r.content[0]!.text!);
const capture = async (args: Record<string, unknown>) =>
  payload(await (captureHandlers.synap_capture!(ctx(args)) as Promise<Result>));

const decision = {
  profileSlug: "decision",
  title: "Every pod app acts as the person",
  properties: { summary: "Apps act as the signed-in person." },
};

beforeEach(() => {
  h.created = [];
  h.graphs = [];
  h.createResult = {
    status: "proposed",
    id: "ent-1",
    proposalId: "create-proposal",
    reviewUrl: "https://pod.example/open/create-proposal",
    proposalType: "entity.create",
    writeReceipt: {
      state: "pending",
      proposalId: "create-proposal",
      reviewUrl: "https://pod.example/open/create-proposal",
      effectiveWorkspaceId: "ws-1",
      source: "agent",
    },
  };
});

describe("synap_capture with exactly one plain entity", () => {
  it("files it through the typed create door, not the import graph", async () => {
    const out = await capture({ entities: [decision] });
    expect(h.graphs).toHaveLength(0);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      profileSlug: "decision",
      title: "Every pod app acts as the person",
      properties: { summary: "Apps act as the signed-in person." },
    });
    // The receipt a capture caller reads is unchanged in shape.
    expect(out.status).toBe("proposed");
    expect(out.proposalId).toBe("create-proposal");
    expect(out.reviewUrl).toBe("https://pod.example/open/create-proposal");
    expect(out.writeReceipt.state).toBe("pending");
    expect(out.scope).toEqual({
      workspaceId: "ws-1",
      projectId: "proj-1",
      sessionId: "sess-1",
    });
    expect(out.entityCount).toBe(1);
    expect(out.applied).toBe(false);
    expect(out.entityIds).toBeUndefined();
  });

  it("an applied create reports status applied and the entityIds", async () => {
    h.createResult = {
      status: "created",
      id: "ent-9",
      writeReceipt: {
        state: "applied",
        entityId: "ent-9",
        effectiveWorkspaceId: null,
        source: "agent",
      },
    };
    const out = await capture({ entities: [decision] });
    expect(h.graphs).toHaveLength(0);
    expect(out.status).toBe("applied");
    expect(out.applied).toBe(true);
    expect(out.entityIds).toEqual(["ent-9"]);
  });

  it("the summary becomes the governance reason; facets map to the typed shape", async () => {
    await capture({
      summary: "Founder decision",
      entities: [
        {
          ...decision,
          facets: [{ profileSlug: "client", properties: { tier: "a" } }],
        },
      ],
    });
    expect(h.created[0]).toMatchObject({
      reasoning: "Founder decision",
      facets: [{ slug: "client", properties: { tier: "a" } }],
    });
  });
});

describe("what stays on the graph", () => {
  it("two entities stay one all-or-none graph", async () => {
    await capture({
      entities: [decision, { profileSlug: "note", title: "Second" }],
    });
    expect(h.created).toHaveLength(0);
    expect(h.graphs).toHaveLength(1);
  });

  it("one entity with a relation stays a graph", async () => {
    await capture({
      entities: [
        { ...decision, ref: "d" },
        { profileSlug: "note", title: "Context", ref: "n" },
      ],
      relations: [{ sourceRef: "d", targetRef: "n", type: "relates_to" }],
    });
    expect(h.created).toHaveLength(0);
    expect(h.graphs).toHaveLength(1);
  });

  it("an existingEntityId link stays a graph (the typed door cannot link)", async () => {
    await capture({
      entities: [
        {
          profileSlug: "person",
          title: "Ada",
          existingEntityId: "11111111-1111-4111-8111-111111111111",
        },
      ],
    });
    expect(h.created).toHaveLength(0);
    expect(h.graphs).toHaveLength(1);
  });

  it("a facet with a status stays a graph (the typed door would drop it)", async () => {
    await capture({
      entities: [
        {
          ...decision,
          facets: [{ profileSlug: "client", status: "active" }],
        },
      ],
    });
    expect(h.created).toHaveLength(0);
    expect(h.graphs).toHaveLength(1);
  });

  it("text beside the entity stays a graph (rawSource provenance)", async () => {
    await capture({
      text: "The founder said every pod app acts as the person.",
      entities: [decision],
    });
    expect(h.created).toHaveLength(0);
    expect(h.graphs).toHaveLength(1);
  });

  it("a connected plan step stays a graph", async () => {
    await capture({
      entities: [decision],
      projects: [{ ref: "p", name: "Process" }],
    });
    expect(h.created).toHaveLength(0);
    expect(h.graphs).toHaveLength(1);
  });
});
