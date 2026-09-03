/**
 * AN ENTITY'S BODY WAS WRITE-ONCE.
 *
 * `synap_capture` / `synap_create_entity` accept `content` and materialize it
 * as the entity's linked document (`entities.documentId`). `synap_get_document`
 * can read it back. But NO MCP door could UPDATE it — `synap_update_entity`
 * took title/description/properties/metadata and nothing else. A live agent
 * wrote 12 documents and then had to delete-and-recreate an entity to fix one
 * factual error in its body.
 *
 * The loop already existed on the backend: `documents.createDocumentProposal`
 * (hub protocol) files the edit, and the `targetType === "document"` branch of
 * `proposals/apply-approval.ts` applies it (upload + `document_versions` row).
 * Only the MCP wiring was missing. These tests pin the wiring:
 *
 *  1. `content` reaches the GOVERNED document door and comes back `proposed`
 *     (never applied silently, never a second write path).
 *  2. A content-only call files NO all-undefined entity proposal.
 *  3. An entity with no `documentId` is REFUSED with the door that fixes it —
 *     not a silent no-op.
 *  4. The document is resolved through `entities.get` (the access floor
 *     `entityReadVisibleWhere`), not a bare id lookup.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  /** What the mocked, access-floored `entities.get` returns. */
  entityRow: { documentId: "dddddddd-1111-4111-8111-111111111111" } as {
    documentId: string | null;
  } | null,
  getCalls: [] as Array<{ id: string }>,
  proposalCalls: [] as Array<Record<string, unknown>>,
  updateEntityCalls: [] as Array<Record<string, unknown>>,
  getDocumentCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../entities.js", () => ({
  entitiesRouter: {
    createCaller: () => ({
      get: async (input: { id: string }) => {
        h.getCalls.push(input);
        if (!h.entityRow) throw new Error("Entity not found");
        return { entity: h.entityRow };
      },
    }),
  },
}));

vi.mock("../../hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: async () => ({}),
}));

import { entityHandlers } from "./entity.js";
import type { McpToolContext } from "./shared.js";

const USER = "user-owner";
const ENTITY_ID = "eeeeeeee-1111-4111-8111-111111111111";
const DOC_ID = "dddddddd-1111-4111-8111-111111111111";

/** Minimal hub caller: only the procedures this handler actually calls. */
const fakeCaller = {
  documents: {
    getDocument: async (input: Record<string, unknown>) => {
      h.getDocumentCalls.push(input);
      return { document: { content: "old body" } };
    },
    createDocumentProposal: async (input: Record<string, unknown>) => {
      h.proposalCalls.push(input);
      return { status: "proposed", proposalId: "prop-1" };
    },
  },
};

const fakeLensCaller = {
  entities: {
    updateEntity: async (input: Record<string, unknown>) => {
      h.updateEntityCalls.push(input);
      return { status: "updated", entityId: ENTITY_ID };
    },
  },
};

function ctx(args: Record<string, unknown>): McpToolContext {
  return {
    toolName: "synap_update_entity",
    args,
    userId: USER,
    apiKeyScopes: ["mcp.read", "mcp.write"],
    caller: fakeCaller,
    lensCaller: fakeLensCaller,
  } as unknown as McpToolContext;
}

function payload(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0]!.text!);
}

beforeEach(() => {
  h.entityRow = { documentId: DOC_ID };
  h.getCalls = [];
  h.proposalCalls = [];
  h.updateEntityCalls = [];
  h.getDocumentCalls = [];
});

const update = entityHandlers.synap_update_entity!;

describe("synap_update_entity — the body is now writable", () => {
  it("routes `content` to the governed document door and reports it as proposed", async () => {
    const result = (await update(
      ctx({ entityId: ENTITY_ID, content: "corrected body" })
    )) as { content: Array<{ text?: string }> };

    // GOVERNANCE: the edit went through `createDocumentProposal`, carrying the
    // prior content so the reviewer sees a diff — and came back `proposed`,
    // never applied behind the user's back.
    expect(h.proposalCalls).toHaveLength(1);
    expect(h.proposalCalls[0]).toMatchObject({
      documentId: DOC_ID,
      userId: USER,
      proposalType: "ai_edit",
      proposedContent: "corrected body",
      originalContent: "old body",
    });
    expect(payload(result).body).toMatchObject({
      documentId: DOC_ID,
      status: "proposed",
    });
  });

  it("reads the current body first so the proposal carries a real diff range", async () => {
    await update(ctx({ entityId: ENTITY_ID, content: "corrected body" }));
    expect(h.getDocumentCalls).toEqual([{ documentId: DOC_ID, userId: USER }]);
    expect(h.proposalCalls[0]!.changes).toEqual([
      { op: "replace", range: [0, "old body".length], text: "corrected body" },
    ]);
  });

  it("resolves the document through the access-floored entities.get, not a bare id lookup", async () => {
    await update(ctx({ entityId: ENTITY_ID, content: "x" }));
    expect(h.getCalls).toEqual([{ id: ENTITY_ID }]);
  });

  it("a content-only call files NO all-undefined entity proposal", async () => {
    await update(ctx({ entityId: ENTITY_ID, content: "x" }));
    expect(h.updateEntityCalls).toHaveLength(0);
  });

  it("content alongside entity fields reports BOTH outcomes independently", async () => {
    const result = (await update(
      ctx({ entityId: ENTITY_ID, title: "New title", content: "x" })
    )) as { content: Array<{ text?: string }> };

    expect(h.updateEntityCalls).toHaveLength(1);
    expect(h.updateEntityCalls[0]).toMatchObject({ title: "New title" });
    const out = payload(result);
    // The entity half may auto-approve while the body half is still pending —
    // collapsing them into one status is what would make a half-applied write
    // read as fully applied.
    expect(out.status).toBe("updated");
    expect(out.body.status).toBe("proposed");
  });

  it("an entity with no body document is REFUSED, naming the door that creates one", async () => {
    h.entityRow = { documentId: null };
    const result = (await update(
      ctx({ entityId: ENTITY_ID, content: "x" })
    )) as { isError?: boolean; content: Array<{ text?: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("synap_create_document");
    // A refusal, not a silent no-op: nothing was written on either half.
    expect(h.proposalCalls).toHaveLength(0);
    expect(h.updateEntityCalls).toHaveLength(0);
  });

  it("still updates entity fields when no content is supplied (no regression)", async () => {
    await update(ctx({ entityId: ENTITY_ID, title: "T", description: "D" }));
    expect(h.updateEntityCalls[0]).toMatchObject({
      entityId: ENTITY_ID,
      title: "T",
      preview: "D",
    });
    expect(h.getCalls).toHaveLength(0);
    expect(h.proposalCalls).toHaveLength(0);
  });
});
