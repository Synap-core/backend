/**
 * APPROVING AN IMPORT GRAPH NEVER HANDS AN IMPORT FORMAT TO THE ENTITY DOOR.
 *
 * THE BUG (founder, proposal 4d3e8f37): `data.source` carries TWO vocabularies
 * under one name. Import proposals stamp their FORMAT there (`markdown`, and
 * `connector_sync` from the connector bridge); the approval path forwarded it
 * into `materializeCompositeGraph`, which passed it to `entities.create` —
 * whose `source` is the ACTOR vocabulary (`PROPOSAL_SOURCES`). Zod refused it
 * with `invalid_value`, so every such proposal was unapprovable.
 *
 * REACHABILITY: a real composite payload through the real
 * `applyProposalApproval` and the REAL materializer; the entity caller parses
 * its input with the REAL `entities.create` input schema, so a format that
 * reaches the door fails exactly as it did live.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  seenSources: [] as unknown[],
  schema: undefined as undefined | { parse: (v: unknown) => unknown },
}));

function statementResult(rows: unknown[]) {
  const p = Promise.resolve(rows) as Promise<unknown[]> & {
    returning: () => Promise<unknown[]>;
    onConflictDoNothing: () => Promise<unknown[]>;
  };
  p.returning = async () => rows;
  p.onConflictDoNothing = async () => rows;
  return p;
}

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {
    query: { proposals: { findFirst: async () => undefined } },
    insert: () => ({ values: () => statementResult([]) }),
    update: () => ({
      set: () => ({ where: () => statementResult([]) }),
    }),
  },
}));
vi.mock("../approve-executors.js", () => ({
  registerApproveExecutors: () => {},
}));
vi.mock("../../entities.js", () => ({
  entitiesRouter: {
    createCaller: () => ({
      create: async (input: unknown) => {
        // The REAL door's input validation — a format here throws.
        const parsed = h.schema!.parse(input) as { source?: unknown };
        h.seenSources.push(parsed.source);
        return { id: `entity-${h.seenSources.length}` };
      },
    }),
  },
}));
vi.mock("../../relations.js", () => ({
  relationsRouter: { createCaller: () => ({}) },
}));
vi.mock("../../../services/proposals/approval-idempotency.js", () => ({
  approvalIdempotency: () => undefined,
}));
vi.mock("../../../services/proposals/reconcile-proposal-properties.js", () => ({
  reconcileApprovedProperties: async (a: { properties: unknown }) => a,
}));
vi.mock("../../../services/proposals/complete-knowledge-proposal.js", () => ({
  completeKnowledgeProposalProperties: () => undefined,
}));
vi.mock("../../../lib/ai-events.js", () => ({
  AI_KIND: { EXTRACT: "extract" },
}));
vi.mock("../../../utils/ai-feedback-events.js", () => ({
  emitAiCorrection: async () => {},
}));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => {},
}));
vi.mock("../../../realtime/socket-events.js", () => ({
  SERVER_CONVERSATION_EVENTS: {},
}));
vi.mock("../../../utils/intelligence-routing.js", () => ({
  getDefaultActiveService: async () => null,
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: () => {},
  getBoss: () => ({ send: async () => {} }),
}));

const { createProcs } = await import("../../entities/create.js");
h.schema = (
  createProcs.create as unknown as {
    _def: { inputs: Array<{ parse: (v: unknown) => unknown }> };
  }
)._def.inputs[0];

const { applyProposalApproval } = await import("../apply-approval.js");
type ApplyArgs = Parameters<typeof applyProposalApproval>[0];

function importGraph(source: string): ApplyArgs {
  return {
    proposal: {
      id: "4d3e8f37-0000-4000-8000-000000000001",
      targetType: "entity",
      targetId: "target-1",
      proposalType: "import.graph",
      workspaceId: null,
      sessionId: null,
      projectId: null,
      agentUserId: null,
      subjectUserId: "user-1",
      sourceMessageId: null,
      correlationId: null,
      data: {
        operations: [
          {
            op: "create_entity",
            ref: "n1",
            profileSlug: "note",
            title: "Imported note",
          },
        ],
        source,
      },
    },
    userId: "user-1",
    input: { proposalId: "4d3e8f37-0000-4000-8000-000000000001" },
    ctx: {} as ApplyArgs["ctx"],
  } as unknown as ApplyArgs;
}

describe("approval of an import graph normalizes `data.source`", () => {
  beforeEach(() => {
    h.seenSources.length = 0;
  });

  it.each(["markdown", "connector_sync"])(
    "an import format (%s) materializes as the human actor `user`",
    async (format) => {
      const result = await applyProposalApproval(importGraph(format));
      expect(result).toEqual(expect.objectContaining({ success: true }));
      expect(h.seenSources).toEqual(["user"]);
    }
  );

  it("a real provenance value (`agent`) passes through unchanged", async () => {
    await applyProposalApproval(importGraph("agent"));
    expect(h.seenSources).toEqual(["agent"]);
  });
});

describe("the materializer stamps ONLY the normalized source on its doors", () => {
  const src = readFileSync(
    join(__dirname, "..", "..", "..", "utils", "materialize-composite.ts"),
    "utf8"
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("every door `source:` is `materializeSource`, derived from normalizeProposalSource", () => {
    const sourceProps = [...src.matchAll(/\bsource:\s*([^,\n}]+)/g)].map((m) =>
      m[1].trim()
    );
    // Non-vacuity: entity create, facet attach, and the rule-loop/door stamps.
    expect(sourceProps.length).toBeGreaterThanOrEqual(3);
    expect(sourceProps.filter((v) => v !== "materializeSource")).toEqual([]);
    expect(src).toMatch(
      /const materializeSource = normalizeProposalSource\(\s*options\?\.source \?\? "system"\s*\)/
    );
  });
});
