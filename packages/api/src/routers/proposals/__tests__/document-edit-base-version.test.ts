/**
 * APPROVING AN AI DOCUMENT EDIT MUST NOT OVERWRITE A LATER HUMAN SAVE.
 *
 * THE DEFECT: the document-content branch (B3) of `applyProposalApproval`
 * uploaded `proposedContent` over current storage without comparing anything.
 * A person who saved after the AI filed its edit lost that save, silently.
 *
 * THE FIX: the filing door records the base it drafted against — the content
 * revision (0275+) or, for older proposals, the checkpoint `baseVersion` — and
 * B3 refuses (CONFLICT) before any write when the document moved past it; the
 * write itself goes through `claimDocumentRevision`, whose compare-and-set
 * closes the race.
 *
 * Driven through the REAL `applyProposalApproval` and the REAL
 * `claimDocumentRevision` inside a REAL transaction, on PGlite. Stubbed:
 * storage (an in-memory blob map with the providers' checksum shape) and the
 * realtime emit. A stale approval must write NOTHING — no upload, no version
 * row, no revision bump, no status flip — and throw so the proposal stays
 * pending.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  blobs: new Map<string, string>(),
  uploads: [] as string[],
}));

const sha = (text: string) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: {
        documents: schema.documents,
        documentVersions: schema.documentVersions,
        proposals: schema.proposals,
      } as never,
    }),
    uploadDocumentVersionSnapshot: async (i: {
      versionId: string;
      content: string | Buffer;
      mimeType?: string | null;
    }) => ({
      storageUrl: `versions/${i.versionId}`,
      storageKey: `versions/${i.versionId}`,
      size: String(i.content).length,
      mimeType: i.mimeType ?? "text/markdown",
      checksum: sha(String(i.content)),
      contentPreview: String(i.content).slice(0, 100),
    }),
    emitDocumentContentReplaced: async () => ({ ok: true }),
  };
});
vi.mock("@synap/storage", () => ({
  storage: {
    buildPath: (u: string, k: string, id: string, ext: string) =>
      `${u}/${k}/${id}.${ext}`,
    upload: async (key: string, body: string | Buffer) => {
      const text = Buffer.isBuffer(body) ? body.toString("utf-8") : body;
      h.uploads.push(key);
      h.blobs.set(key, text);
      return { url: key, path: key, size: text.length, checksum: sha(text) };
    },
    downloadBuffer: async (key: string) =>
      Buffer.from(h.blobs.get(key) ?? "", "utf-8"),
  },
}));
vi.mock("../approve-executors.js", () => ({
  registerApproveExecutors: () => {},
}));
vi.mock("../graph-dispositions.js", () => ({
  applyGraphDispositions: () => ({}),
  survivingEntityDecisionSlices: () => ({}),
  survivingEntityFacetSlices: () => ({}),
  foldFacetsIntoOps: (ops: unknown) => ops,
}));
vi.mock("../../entities.js", () => ({ entitiesRouter: {} }));
vi.mock("../../relations.js", () => ({ relationsRouter: {} }));
vi.mock("../../../utils/materialize-composite.js", () => ({
  materializeCompositeGraph: async () => ({}),
}));
vi.mock("../../../services/proposals/reconcile-proposal-properties.js", () => ({
  reconcileApprovedProperties: async (a: unknown) => a,
}));
vi.mock("../../../services/proposals/complete-knowledge-proposal.js", () => ({
  completeKnowledgeProposalProperties: async (p: unknown) => p,
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

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { documents, documentVersions, proposals } from "@synap/database/schema";

const { applyProposalApproval } = await import("../apply-approval.js");

type ApplyArgs = Parameters<typeof applyProposalApproval>[0];

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    let def = "";
    if (c.hasDefault) {
      if (typeof c.default === "number" || typeof c.default === "boolean")
        def = ` default ${c.default}`;
      else if (typeof c.default === "string")
        def = ` default '${c.default.replace(/'/g, "''")}'`;
      else if (type === "uuid") def = " default gen_random_uuid()";
      else if (type.startsWith("timestamp")) def = " default now()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const DOC = "00000000-0000-4000-8000-0000000000d1";
const PROPOSAL = "00000000-0000-4000-8000-0000000000p1".replace("p", "a");
const BODY = "Human text.";
const KEY = "docs/doc-1.md";

function approveDocumentEdit(data: Record<string, unknown>): ApplyArgs {
  return {
    proposal: {
      id: PROPOSAL,
      targetType: "document",
      targetId: DOC,
      proposalType: "ai_edit",
      workspaceId: null,
      sessionId: null,
      projectId: null,
      agentUserId: "agent-1",
      sourceMessageId: null,
      correlationId: null,
      data,
    } as unknown as ApplyArgs["proposal"],
    userId: "human-approver",
    input: { proposalId: PROPOSAL },
    ctx: {} as ApplyArgs["ctx"],
  };
}

async function state() {
  const {
    rows: [doc],
  } = await q<{ current_version: number; content_revision: number }>(
    `select current_version, content_revision from documents where id = $1`,
    [DOC]
  );
  const {
    rows: [n],
  } = await q<{ n: number }>(
    `select count(*)::int as n from document_versions where document_id = $1`,
    [DOC]
  );
  const {
    rows: [p],
  } = await q<{ status: string }>(
    `select status from proposals where id = $1`,
    [PROPOSAL]
  );
  return {
    ...doc!,
    versionRows: n!.n,
    content: h.blobs.get(KEY),
    proposalStatus: p!.status,
  };
}

beforeAll(async () => {
  for (const t of [documents, documentVersions, proposals])
    await h.client!.exec(ddlFor(t as PgTable));
});

// The document: checkpoint v4 (by a person), content revision 9 (human saves
// since then moved the revision without cutting checkpoints).
beforeEach(async () => {
  h.uploads.length = 0;
  h.blobs.clear();
  h.blobs.set(KEY, BODY);
  await q(`delete from document_versions`);
  await q(`delete from documents`);
  await q(`delete from proposals`);
  await q(
    `insert into documents (id, user_id, title, type, storage_key, mime_type, current_version, last_saved_version, content_revision)
     values ($1, 'human-approver', 'Plan', 'markdown', $2, 'text/markdown', 4, 4, 9)`,
    [DOC, KEY]
  );
  await q(
    `insert into document_versions (document_id, version, content, author, author_id, checksum)
     values ($1, 4, $2, 'user', 'human-approver', $3)`,
    [DOC, BODY, sha(BODY)]
  );
  await q(
    `insert into proposals (id, created_by, target_type, target_id, proposal_type, status, data)
     values ($1, 'human-approver', 'document', $2, 'ai_edit', 'pending', '{}'::jsonb)`,
    [PROPOSAL, DOC]
  );
});

const UNCHANGED = {
  current_version: 4,
  content_revision: 9,
  versionRows: 1,
  content: BODY,
  proposalStatus: "pending",
};

describe("document edit approval — base revision / version", () => {
  it("REFUSES (CONFLICT) when a person saved after the edit was drafted (revision), and writes nothing", async () => {
    const approval = applyProposalApproval(
      approveDocumentEdit({
        source: "agent",
        proposedContent: "AI text",
        baseRevision: 8,
      })
    );
    await expect(approval).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(approval).rejects.toThrow(
      /drafted against revision 8, now revision 9/
    );
    expect(h.uploads).toEqual([]);
    expect(await state()).toEqual(UNCHANGED);
  });

  it("REFUSES a legacy proposal whose checkpoint version moved, and writes nothing", async () => {
    const approval = applyProposalApproval(
      approveDocumentEdit({
        source: "agent",
        proposedContent: "AI text",
        baseVersion: 3,
      })
    );
    await expect(approval).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(approval).rejects.toThrow(
      /drafted against version 3, now version 4/
    );
    expect(h.uploads).toEqual([]);
    expect(await state()).toEqual(UNCHANGED);
  });

  it("APPLIES at the drafted revision — through the claim door, authored by the agent", async () => {
    const result = await applyProposalApproval(
      approveDocumentEdit({
        source: "agent",
        proposedContent: "AI text",
        baseRevision: 9,
      })
    );
    expect(result.success).toBe(true);
    // The body upload over the document's key (the checkpoint snapshot is a
    // second, version-keyed upload).
    expect(h.uploads.filter((k) => k === KEY)).toEqual([KEY]);
    expect(await state()).toEqual({
      current_version: 5,
      content_revision: 10,
      versionRows: 2,
      content: "AI text",
      proposalStatus: "approved",
    });
    const { rows } = await q<{ author: string; author_id: string }>(
      `select author, author_id from document_versions where document_id = $1 and version = 5`,
      [DOC]
    );
    expect(rows).toEqual([{ author: "ai", author_id: "agent-1" }]);
  });

  it("APPLIES a legacy proposal still at its drafted checkpoint version", async () => {
    const result = await applyProposalApproval(
      approveDocumentEdit({
        source: "agent",
        proposedContent: "AI text",
        baseVersion: 4,
      })
    );
    expect(result.success).toBe(true);
    expect((await state()).content).toBe("AI text");
  });

  it("a proposal filed before base versions existed applies as before", async () => {
    const result = await applyProposalApproval(
      approveDocumentEdit({ source: "agent", proposedContent: "AI text" })
    );
    expect(result.success).toBe(true);
    // The body upload over the document's key (the checkpoint snapshot is a
    // second, version-keyed upload).
    expect(h.uploads.filter((k) => k === KEY)).toEqual([KEY]);
    expect((await state()).content).toBe("AI text");
  });
});
