/**
 * A plan filed BY REF becomes readable BY ID once it applies — through the door
 * the agent already has (`synap_list_proposals`, default summary view).
 *
 * The SEAM, end to end with nothing hand-built between: a real
 * `MaterializeResult` → the real `buildMaterializedRecord` (what approval
 * stamps into `data.materialized`) → the real MCP handler → the real BASIC
 * projection (`toProposalBasic`). Only the row fetch is mocked. A field stamped
 * on the proposal that no read returns would be a producer with no reader.
 */

import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock(
  "../../../services/proposals/proposals-service.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    listCreatedProposals: vi.fn(async () => h.rows),
  })
);

import { readHandlers } from "./read.js";
import type { McpToolContext } from "./shared.js";
import { buildMaterializedRecord } from "../../../services/proposals/stamp-materialized.js";

function ctx(): McpToolContext {
  return {
    toolName: "synap_list_proposals",
    args: {},
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: false,
  };
}

async function listed() {
  const result = await readHandlers.synap_list_proposals!(ctx());
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("expected text");
  return JSON.parse(block.text) as {
    proposals: Array<{
      id: string;
      materializedIds?: Record<
        string,
        { op: string; id: string; linked?: true }
      >;
    }>;
  };
}

describe("synap_list_proposals — plan ids after approval", () => {
  it("returns ref → real id for every applied plan step", async () => {
    const record = buildMaterializedRecord({
      entities: [
        {
          ref: "acme",
          opIndex: 0,
          entityId: "ent-1",
          profileSlug: "company",
          linked: false,
        },
      ],
      relations: [],
      projects: [{ ref: "p1", opIndex: 1, projectId: "proj-1", linked: false }],
      sessions: [
        { ref: "s0", opIndex: 2, sessionId: "sess-root" },
        { ref: "s1", opIndex: 3, sessionId: "sess-child" },
      ],
      documents: [{ ref: "spec", opIndex: 4, documentId: "doc-1" }],
      links: [],
    });
    h.rows = [
      {
        id: "prop-1",
        proposalType: "import.graph",
        targetType: "entity",
        targetId: "t",
        status: "approved",
        workspaceId: null,
        correlationId: null,
        sessionId: "sess-room",
        agentUserId: "agent-1",
        data: { operations: [], materialized: record },
      },
    ];

    const { proposals } = await listed();
    expect(proposals[0].materializedIds).toEqual({
      acme: { op: "create_entity", id: "ent-1" },
      p1: { op: "create_project", id: "proj-1" },
      s0: { op: "create_session", id: "sess-root" },
      s1: { op: "create_session", id: "sess-child" },
      spec: { op: "create_document", id: "doc-1" },
    });
  });

  it("a still-pending plan carries NO ids — never a guessed one", async () => {
    h.rows = [
      {
        id: "prop-2",
        proposalType: "import.graph",
        targetType: "entity",
        targetId: "t",
        status: "pending",
        workspaceId: null,
        correlationId: null,
        sessionId: null,
        agentUserId: "agent-1",
        data: { operations: [{ op: "create_session", ref: "s0", goal: "g" }] },
      },
    ];
    const { proposals } = await listed();
    expect("materializedIds" in proposals[0]).toBe(false);
  });
});
