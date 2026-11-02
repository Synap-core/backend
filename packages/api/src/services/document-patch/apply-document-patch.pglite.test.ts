/**
 * THE document patch door, driven for real on PGlite: `applyDocumentPatch`
 * (edit floor → base check → render + floors → diagnostics → governance →
 * the write through the REAL `claimDocumentRevision`), its approval half
 * `applyApprovedDocumentPatch`, and a person's `suggestDocumentPatch`.
 *
 * Stubbed, and why:
 *  - `checkPermissionOrPropose` — records the (action, forcePropose, data) the
 *    door chose; an agent is proposed unless `h.agentAutoApply`. The policy
 *    engine and the rules have their own suites; the seam here is WHICH key
 *    and WHICH payload the door files.
 *  - `loadEditableDocument` — the access layer's edit floor has its own
 *    PGlite suite (`document-edit-access.pglite.test.ts`); here it admits the
 *    ids in `h.editable` and answers NOT_FOUND otherwise.
 *  - `@synap/storage` — an in-memory blob map with the real checksum shape.
 *  - `emitDocumentContentReplaced` — recorded (it would POST to the realtime
 *    bridge).
 *  - `listRenderables` / the access layer's `scopedDb` — diagnostics lookups;
 *    `h.catalogFails` makes the catalog read throw.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID, createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  blobs: new Map<string, string>(),
  gate: [] as Array<{
    action: string;
    forcePropose?: boolean;
    data: Record<string, unknown>;
  }>,
  agentAutoApply: false,
  editable: new Set<string>(),
  replaced: [] as Array<{ documentId: string; revision: number }>,
  catalogFails: false,
  filed: [] as Array<Record<string, unknown>>,
  /** Ids the scope floor lets the writer read (spaces, projects, automations…). */
  readable: new Set<string>(),
}));

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
      } as never,
    }),
    uploadDocumentVersionSnapshot: async (i: {
      versionId: string;
      content: string | Buffer;
      mimeType?: string | null;
    }) => {
      const key = `versions/${i.versionId}`;
      h.blobs.set(key, String(i.content));
      return {
        storageUrl: key,
        storageKey: key,
        size: String(i.content).length,
        mimeType: i.mimeType ?? "text/markdown",
        checksum: `sha256:${createHash("sha256").update(String(i.content)).digest("hex")}`,
        contentPreview: String(i.content).slice(0, 100),
      };
    },
    emitDocumentContentReplaced: async (t: {
      documentId: string;
      revision: number;
    }) => {
      h.replaced.push({ documentId: t.documentId, revision: t.revision });
      return { ok: true };
    },
  };
});

vi.mock("@synap/storage", () => ({
  storage: {
    buildPath: (u: string, k: string, id: string, ext: string) =>
      `${u}/${k}/${id}.${ext}`,
    upload: async (key: string, body: string | Buffer) => {
      const text = Buffer.isBuffer(body) ? body.toString("utf-8") : body;
      h.blobs.set(key, text);
      const checksum = `sha256:${createHash("sha256").update(text).digest("hex")}`;
      return { url: key, path: key, size: text.length, checksum };
    },
    downloadBuffer: async (key: string) =>
      Buffer.from(h.blobs.get(key) ?? "", "utf-8"),
  },
}));

vi.mock("@synap/events", () => ({ emitSideEffects: async () => undefined }));

vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (opts: {
    agentUserId?: string;
    action: string;
    forcePropose?: boolean;
    data: Record<string, unknown>;
  }) => {
    h.gate.push({
      action: opts.action,
      forcePropose: opts.forcePropose,
      data: opts.data,
    });
    if (!opts.agentUserId || (h.agentAutoApply && !opts.forcePropose))
      return { granted: true };
    return {
      granted: false,
      proposalId: "prop-1",
      proposalType: `document.${opts.action}`,
      summary: "s",
      reasoning: "r",
      reviewPath: "/open/prop-1",
      reviewUrl: "https://pod/open/prop-1",
    };
  },
}));

vi.mock("../../utils/event-backed-proposal.js", () => ({
  createEventBackedProposal: async (input: Record<string, unknown>) => {
    h.filed.push(input);
    return { proposal: { id: "suggestion-1" } };
  },
}));

vi.mock("../../utils/document-edit-access.js", () => ({
  loadEditableDocument: async (_userId: string, documentId: string) => {
    if (!h.editable.has(documentId)) {
      const { TRPCError } = await import("@trpc/server");
      throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
    }
    return { id: documentId };
  },
}));

vi.mock("../cells/renderables.js", () => ({
  listRenderables: async () => {
    if (h.catalogFails) throw new Error("catalog read failed");
    return [];
  },
}));

// The scope floor: which ids the writer can read (its own predicate is the
// access layer's suite, and `document-scope.test.ts` drives the reading).
vi.mock("../document-scope/document-scope.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const can = async (ids: readonly string[]) =>
    new Set(ids.filter((id) => h.readable.has(id)));
  return {
    ...actual,
    podDocumentScopeFloor: () => ({
      workspaces: can,
      visible: (_kind: string, ids: readonly string[]) => can(ids),
    }),
  };
});

vi.mock("../../access/index.js", () => ({
  AccessContext: {
    operator: () => ({ withLens: () => ({}) }),
  },
  scopedDb: () => ({ findMany: async () => [] }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  automationRuns,
  documents,
  documentVersions,
  focusSessions,
} from "@synap/database/schema";
import {
  applyDocumentPatch,
  applyApprovedDocumentPatch,
  suggestDocumentPatch,
} from "./apply-document-patch.js";

const USER = "user-1";
const AGENT = "agent-1";
const WS = "11111111-1111-4111-8111-111111111111";

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

const human = (id: string, body: string) =>
  [
    `::::synap-section{id="${id}" owner="human"}`,
    `## ${id}`,
    "",
    body,
    "::::",
  ].join("\n");
const BODY = [
  "# Plan",
  "",
  "We ship on Friday.",
  "",
  human("notes", "My own notes."),
  "",
].join("\n");

async function newDocument(content = BODY): Promise<string> {
  const id = randomUUID();
  const key = `u/document/${id}.md`;
  h.blobs.set(key, content);
  const checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  await q(
    `insert into documents (id, user_id, workspace_id, title, type, storage_key, mime_type, current_version, last_saved_version, content_revision)
     values ($1, $2, $3, 'Plan', 'markdown', $4, 'text/markdown', 1, 1, 1)`,
    [id, USER, WS, key]
  );
  await q(
    `insert into document_versions (document_id, version, content, author, author_id, checksum)
     values ($1, 1, $2, 'user', $3, $4)`,
    [id, content, USER, checksum]
  );
  h.editable.add(id);
  return id;
}

async function row(id: string) {
  const { rows } = await q<{
    content_revision: number;
    storage_key: string;
    metadata: unknown;
  }>(
    `select content_revision, storage_key, metadata from documents where id = $1`,
    [id]
  );
  return { ...rows[0]!, content: h.blobs.get(rows[0]!.storage_key) ?? "" };
}

beforeAll(async () => {
  for (const t of [documents, documentVersions, focusSessions, automationRuns])
    await h.client!.exec(ddlFor(t as PgTable));
});

beforeEach(() => {
  h.gate = [];
  h.agentAutoApply = false;
  h.replaced = [];
  h.catalogFails = false;
  h.filed = [];
  h.readable = new Set();
});

describe("applyDocumentPatch — a person's patch applies", () => {
  it("writes through the revision door, tells open editors, stamps diagnostics for the NEW revision", async () => {
    const id = await newDocument();
    const res = await applyDocumentPatch({
      userId: USER,
      documentId: id,
      baseRevision: 1,
      ops: [{ op: "replace_text", old: "on Friday", new: "on Monday" }],
    });
    expect(res.status).toBe("applied");
    const after = await row(id);
    expect(after.content).toContain("We ship on Monday.");
    expect(after.content_revision).toBe(2);
    expect(res).toMatchObject({
      status: "applied",
      revision: 2,
      diagnostics: [],
    });
    expect(h.replaced).toEqual([{ documentId: id, revision: 2 }]);
    expect(
      (after.metadata as { diagnostics: { revision: number } }).diagnostics
        .revision
    ).toBe(2);
    // A text patch files under document.update.
    expect(h.gate.map((g) => g.action)).toEqual(["update"]);
  });

  it("a stale base is a CONFLICT and writes nothing", async () => {
    const id = await newDocument();
    await expect(
      applyDocumentPatch({
        userId: USER,
        documentId: id,
        baseRevision: 0,
        ops: [{ op: "append", body: "more" }],
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await row(id)).content).toBe(BODY);
    expect(h.gate).toEqual([]);
  });

  it("a document the caller may not edit is NOT_FOUND before anything runs", async () => {
    const id = await newDocument();
    h.editable.delete(id);
    await expect(
      applyDocumentPatch({
        userId: USER,
        documentId: id,
        ops: [{ op: "append", body: "x" }],
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.gate).toEqual([]);
  });

  it("replace_all without the revision you read is refused", async () => {
    const id = await newDocument();
    await expect(
      applyDocumentPatch({
        userId: USER,
        documentId: id,
        ops: [{ op: "replace_all", content: "x" }],
      })
    ).rejects.toThrow(/needs the revision you read/);
  });

  it("diagnostics that cannot run never block the write — and are not reported as clean", async () => {
    const id = await newDocument();
    h.catalogFails = true;
    const res = await applyDocumentPatch({
      userId: USER,
      documentId: id,
      ops: [{ op: "append", body: ':::synap-cell{cellKey="chart-bar"}\n:::' }],
    });
    expect(res.status).toBe("applied");
    expect(res.diagnostics).toBeNull();
    expect(res.diagnosticsError).toMatch(/catalog read failed/);
    expect((await row(id)).metadata).toBeNull();
  });
});

describe("applyDocumentPatch — an agent's patch is a proposal", () => {
  it("files {ops, baseRevision, preview, diagnostics} and writes nothing", async () => {
    const id = await newDocument();
    const res = await applyDocumentPatch({
      userId: USER,
      agentUserId: AGENT,
      documentId: id,
      ops: [{ op: "replace_text", old: "on Friday", new: "on Monday" }],
    });
    expect(res.status).toBe("proposed");
    expect((await row(id)).content).toBe(BODY);
    const filed = h.gate[0]!;
    expect(filed.action).toBe("update");
    expect(filed.data).toMatchObject({
      documentId: id,
      ops: [{ op: "replace_text", old: "on Friday", new: "on Monday" }],
      baseRevision: 1,
      diagnostics: [],
      author: AGENT,
    });
    expect(filed.data.preview).toEqual([
      {
        sectionId: null,
        title: null,
        before: "We ship on Friday.",
        after: "We ship on Monday.",
      },
    ]);
  });

  it("a section-only patch files under document.section_update", async () => {
    const id = await newDocument();
    await applyDocumentPatch({
      userId: USER,
      agentUserId: AGENT,
      documentId: id,
      ops: [
        { op: "upsert_section", id: "risks", title: "Risks", body: "None." },
      ],
    });
    expect(h.gate.map((g) => g.action)).toEqual(["section_update"]);
  });

  it("an agent replace_all is FORCED to a proposal, even where a rule would apply it", async () => {
    const id = await newDocument();
    h.agentAutoApply = true;
    const res = await applyDocumentPatch({
      userId: USER,
      agentUserId: AGENT,
      documentId: id,
      baseRevision: 1,
      ops: [{ op: "replace_all", content: BODY.replace("Friday", "Sunday") }],
    });
    expect(h.gate[0]!.forcePropose).toBe(true);
    expect(res.status).toBe("proposed");
  });

  it("…while a rule MAY apply an agent's text patch (auto-approval only through governance)", async () => {
    const id = await newDocument();
    h.agentAutoApply = true;
    const res = await applyDocumentPatch({
      userId: USER,
      agentUserId: AGENT,
      documentId: id,
      ops: [{ op: "replace_text", old: "on Friday", new: "on Monday" }],
    });
    expect(h.gate[0]!.forcePropose).toBeUndefined();
    expect(res.status).toBe("applied");
    const { rows } = await q<{ author: string; author_id: string }>(
      `select author, author_id from document_versions where document_id = $1 order by version desc limit 1`,
      [id]
    );
    expect(rows[0]).toEqual({ author: "ai", author_id: AGENT });
  });

  it("the floors refuse BEFORE governance: a person's section is never proposed over", async () => {
    const id = await newDocument();
    await expect(
      applyDocumentPatch({
        userId: USER,
        agentUserId: AGENT,
        documentId: id,
        ops: [{ op: "replace_text", old: "My own notes.", new: "AI notes." }],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.gate).toEqual([]);
  });
});

describe("applyApprovedDocumentPatch — the approval half", () => {
  async function proposalFor(id: string, ops: unknown[]) {
    await applyDocumentPatch({
      userId: USER,
      agentUserId: AGENT,
      documentId: id,
      ops: ops as never,
    });
    return {
      targetId: id,
      agentUserId: AGENT,
      data: h.gate[h.gate.length - 1]!.data,
    };
  }

  it("re-applies the ops at approval, authored by the agent", async () => {
    const id = await newDocument();
    const proposal = await proposalFor(id, [
      { op: "replace_text", old: "on Friday", new: "on Monday" },
    ]);
    const applied = await applyApprovedDocumentPatch(proposal, USER);
    expect(applied.revision).toBe(2);
    expect((await row(id)).content).toContain("on Monday");
    expect(h.replaced).toEqual([{ documentId: id, revision: 2 }]);
  });

  it("a person's save after filing makes approval a CONFLICT (nothing applied over it)", async () => {
    const id = await newDocument();
    const proposal = await proposalFor(id, [
      { op: "replace_text", old: "on Friday", new: "on Monday" },
    ]);
    await applyDocumentPatch({
      userId: USER,
      documentId: id,
      ops: [{ op: "append", body: "A person's line." }],
    });
    await expect(
      applyApprovedDocumentPatch(proposal, USER)
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect((await row(id)).content).not.toContain("on Monday");
  });
});

describe("suggestDocumentPatch — a person's suggestion", () => {
  it("files a user_edit proposal carrying ops + the revision it was drafted on; approval credits the suggester", async () => {
    const id = await newDocument();
    const res = await suggestDocumentPatch({
      userId: USER,
      documentId: id,
      ops: [{ op: "replace_text", old: "on Friday", new: "on Tuesday" }],
    });
    expect(res.proposalId).toBe("suggestion-1");
    expect(h.filed[0]).toMatchObject({
      proposalType: "user_edit",
      targetType: "document",
      targetId: id,
      data: { baseRevision: 1, ops: [{ op: "replace_text" }] },
    });
    // Nothing written until someone accepts it.
    expect((await row(id)).content).toBe(BODY);

    await applyApprovedDocumentPatch(
      {
        targetId: id,
        agentUserId: null,
        createdBy: USER,
        data: h.filed[0]!.data,
      },
      "user-2"
    );
    const { rows } = await q<{ author: string; author_id: string }>(
      `select author, author_id from document_versions where document_id = $1 order by version desc limit 1`,
      [id]
    );
    expect(rows[0]).toEqual({ author: "user", author_id: USER });
  });
});

// ONE TITLE (founder 2026-10-19): the document's name is its one title. A
// whole-body replace that opens with a heading equal to it lands without that
// heading — in what a person reviews (the proposal's ops + preview) and in
// what is stored on approval. A heading that differs is content.
describe("applyDocumentPatch — one title on a whole-body replace", () => {
  it("a person's replace_all opening with `# <name>` is stored without it", async () => {
    const id = await newDocument();
    const res = await applyDocumentPatch({
      userId: USER,
      documentId: id,
      baseRevision: 1,
      ops: [{ op: "replace_all", content: "# Plan\n\nWe ship on Monday.\n" }],
    });
    expect(res.status).toBe("applied");
    expect((await row(id)).content).toBe("We ship on Monday.\n");
  });

  it("an agent's proposal carries the body without the name — what is reviewed is what lands", async () => {
    // No person's section: an agent may rewrite the whole of this one.
    const id = await newDocument("# Plan\n\nWe ship on Friday.\n");
    const res = await applyDocumentPatch({
      userId: USER,
      agentUserId: AGENT,
      documentId: id,
      baseRevision: 1,
      ops: [
        { op: "replace_all", content: "## plan\n\nRewritten by the agent.\n" },
      ],
    });
    expect(res.status).toBe("proposed");
    expect(h.gate[0]!.data.ops).toEqual([
      { op: "replace_all", content: "Rewritten by the agent.\n" },
    ]);
    await applyApprovedDocumentPatch(
      {
        targetId: id,
        agentUserId: AGENT,
        createdBy: AGENT,
        data: h.gate[0]!.data,
      },
      USER
    );
    expect((await row(id)).content).toBe("Rewritten by the agent.\n");
  });

  it("a leading heading that DIFFERS from the name is kept", async () => {
    const id = await newDocument();
    await applyDocumentPatch({
      userId: USER,
      documentId: id,
      baseRevision: 1,
      ops: [{ op: "replace_all", content: "# Plan B\n\nAnother plan.\n" }],
    });
    expect((await row(id)).content).toBe("# Plan B\n\nAnother plan.\n");
  });
});

// RENAME (set_title): no governed agent door could rename a document — pod
// document deb1a133 stayed "Untitled". `set_title` is one more op of THE patch
// door: the same apply-or-propose gate, the same base guard, the same approval
// half. The assertion is on the stored `documents.title`.
async function named(id: string) {
  const { rows } = await q<{
    title: string;
    content_revision: number;
    current_version: number;
  }>(
    `select title, content_revision, current_version from documents where id = $1`,
    [id]
  );
  const versions = await q<{ n: number }>(
    `select count(*)::int as n from document_versions where document_id = $1`,
    [id]
  );
  return { ...rows[0]!, versions: versions.rows[0]!.n };
}

describe("applyDocumentPatch — set_title renames the document", () => {
  it("an agent's rename is PROPOSED under document.update; the approval renames, content untouched", async () => {
    const id = await newDocument();
    const res = await applyDocumentPatch({
      userId: USER,
      agentUserId: AGENT,
      documentId: id,
      ops: [{ op: "set_title", title: "Launch plan" }],
    });
    expect(res.status).toBe("proposed");
    expect(res.rename).toEqual({ before: "Plan", after: "Launch plan" });
    expect(h.gate.map((g) => g.action)).toEqual(["update"]);
    expect(h.gate[0]!.data.rename).toEqual({
      before: "Plan",
      after: "Launch plan",
    });
    // Proposed: nothing moved yet.
    expect((await named(id)).title).toBe("Plan");

    const applied = await applyApprovedDocumentPatch(
      {
        targetId: id,
        agentUserId: AGENT,
        createdBy: AGENT,
        data: h.gate[0]!.data,
      },
      USER
    );
    const after = await named(id);
    expect(after.title).toBe("Launch plan");
    // A rename is not a content write: no revision claimed, no version cut.
    expect(after.content_revision).toBe(1);
    expect(after.versions).toBe(1);
    expect(applied.versionId).toBeNull();
    expect((await row(id)).content).toBe(BODY);
    expect(h.replaced).toEqual([]);
  });

  it("a person's rename applies directly", async () => {
    const id = await newDocument();
    const res = await applyDocumentPatch({
      userId: USER,
      documentId: id,
      ops: [{ op: "set_title", title: "  Launch plan  " }],
    });
    expect(res).toMatchObject({
      status: "applied",
      revision: 1,
      rename: { before: "Plan", after: "Launch plan" },
    });
    expect(res.status === "applied" && res.undo).toBeFalsy();
    expect((await named(id)).title).toBe("Launch plan");
  });

  it("an agent's rename a governance rule auto-approves applies directly", async () => {
    const id = await newDocument();
    h.agentAutoApply = true;
    const res = await applyDocumentPatch({
      userId: USER,
      agentUserId: AGENT,
      documentId: id,
      baseRevision: 1,
      ops: [{ op: "set_title", title: "Launch plan" }],
    });
    expect(res.status).toBe("applied");
    expect(h.gate[0]!.forcePropose).toBeUndefined();
    expect((await named(id)).title).toBe("Launch plan");
  });

  it("a rename with a rewrite: one write, and the one-title rule strips the NEW name's heading", async () => {
    const id = await newDocument("Old body.\n");
    const res = await applyDocumentPatch({
      userId: USER,
      documentId: id,
      baseRevision: 1,
      ops: [
        { op: "replace_all", content: "# Launch plan\n\nNew body.\n" },
        { op: "set_title", title: "Launch plan" },
      ],
    });
    expect(res.status).toBe("applied");
    const after = await named(id);
    expect(after.title).toBe("Launch plan");
    expect(after.content_revision).toBe(2);
    expect((await row(id)).content).toBe("New body.\n");
  });

  it("a stale base is a CONFLICT and renames nothing", async () => {
    const id = await newDocument();
    await expect(
      applyDocumentPatch({
        userId: USER,
        documentId: id,
        baseRevision: 0,
        ops: [{ op: "set_title", title: "Launch plan" }],
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await named(id)).title).toBe("Plan");
  });

  it("an approval over a name a person changed since is a CONFLICT — never overwritten", async () => {
    const id = await newDocument();
    await applyDocumentPatch({
      userId: USER,
      agentUserId: AGENT,
      documentId: id,
      ops: [{ op: "set_title", title: "Launch plan" }],
    });
    await q(`update documents set title = 'Q3 plan' where id = $1`, [id]);
    await expect(
      applyApprovedDocumentPatch(
        {
          targetId: id,
          agentUserId: AGENT,
          createdBy: AGENT,
          data: h.gate[0]!.data,
        },
        USER
      )
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await named(id)).title).toBe("Q3 plan");
  });

  it("a machine label is refused before the gate (titles are derived, never machine labels)", async () => {
    const id = await newDocument();
    for (const title of [randomUUID(), "local-b88d021b7d74", "Document"]) {
      await expect(
        applyDocumentPatch({
          userId: USER,
          agentUserId: AGENT,
          documentId: id,
          ops: [{ op: "set_title", title }],
        })
      ).rejects.toThrow(/not a name a person would read/);
    }
    expect(h.gate).toEqual([]);
    expect((await named(id)).title).toBe("Plan");
  });

  it("renaming to the name it already has files nothing", async () => {
    const id = await newDocument();
    await expect(
      applyDocumentPatch({
        userId: USER,
        agentUserId: AGENT,
        documentId: id,
        ops: [{ op: "set_title", title: "Plan" }],
      })
    ).rejects.toThrow(/already named "Plan"/);
    expect(h.gate).toEqual([]);
  });
});

// ─── Living documents: insert_embed, scope, refresher (0387) ────────────────

async function fields(id: string) {
  const { rows } = await q<{
    scope: unknown;
    refresh_automation_id: string | null;
    content_revision: number;
  }>(
    `select scope, refresh_automation_id, content_revision from documents where id = $1`,
    [id]
  );
  return rows[0]!;
}

describe("applyDocumentPatch — insert_embed writes the directive for the writer", () => {
  it("serializes a cell embed through serializeEmbed and files it under document.update", async () => {
    const id = await newDocument();
    const res = await applyDocumentPatch({
      userId: USER,
      documentId: id,
      baseRevision: 1,
      ops: [
        {
          op: "insert_embed",
          directive: "synap-cell",
          ref: { cellKey: "lens-section" },
          props: { section: "blocking", limit: 5 },
          fallback: "What needs you in this project.",
          after: "We ship on Friday.",
        },
      ],
    });
    expect(res.status).toBe("applied");
    const { content } = await row(id);
    expect(content).toContain(
      [
        "We ship on Friday.",
        "",
        ':::synap-cell{cellKey="lens-section"}',
        "```json",
        '{"section":"blocking","limit":5}',
        "```",
        "",
        "What needs you in this project.",
        ":::",
      ].join("\n")
    );
    // The person's section is still byte-for-byte there.
    expect(content).toContain(human("notes", "My own notes."));
    expect(h.gate.map((g) => g.action)).toEqual(["update"]);
  });

  it("an embed an agent drops into a person's section is refused by the floor", async () => {
    const id = await newDocument();
    await expect(
      applyDocumentPatch({
        userId: USER,
        agentUserId: AGENT,
        documentId: id,
        ops: [
          {
            op: "insert_embed",
            directive: "synap-entity",
            ref: { id: randomUUID() },
            sectionId: "notes",
          },
        ],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.gate).toEqual([]);
  });
});

describe("applyDocumentPatch — set_scope / set_refresher", () => {
  const P = "22222222-2222-4222-8222-222222222222";
  const A = "55555555-5555-4555-8555-555555555555";

  it("a person's scope + refresher apply as fields only: no content revision is cut", async () => {
    const id = await newDocument();
    h.readable = new Set([P, A]);
    const res = await applyDocumentPatch({
      userId: USER,
      documentId: id,
      ops: [
        { op: "set_scope", scope: { kind: "project", projectId: P } },
        { op: "set_refresher", automationId: A },
      ],
    });
    expect(res.status).toBe("applied");
    expect(await fields(id)).toEqual({
      scope: { kind: "project", projectId: P },
      refresh_automation_id: A,
      content_revision: 1,
    });
    expect((await row(id)).content).toBe(BODY);
    // Never a section key: binding a refresher is a document.update.
    expect(h.gate.map((g) => g.action)).toEqual(["update"]);
  });

  it("a scope naming a project the writer cannot read is refused BEFORE the gate", async () => {
    const id = await newDocument();
    await expect(
      applyDocumentPatch({
        userId: USER,
        documentId: id,
        ops: [{ op: "set_scope", scope: { kind: "project", projectId: P } }],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.gate).toEqual([]);
    expect((await fields(id)).scope).toBeNull();
  });

  it("an agent binding a refresher is PROPOSED; the approval binds it", async () => {
    const id = await newDocument();
    h.readable = new Set([A]);
    const res = await applyDocumentPatch({
      userId: USER,
      agentUserId: AGENT,
      documentId: id,
      ops: [{ op: "set_refresher", automationId: A }],
    });
    expect(res.status).toBe("proposed");
    expect((await fields(id)).refresh_automation_id).toBeNull();
    const filed = h.gate[0]!;
    await applyApprovedDocumentPatch(
      { targetId: id, agentUserId: AGENT, data: filed.data },
      USER
    );
    expect((await fields(id)).refresh_automation_id).toBe(A);
  });
});

describe("applyDocumentPatch — the bound refresher (decision D4)", () => {
  const AUTOMATION = "66666666-6666-4666-8666-666666666666";
  const aiSection = (id: string, body: string) =>
    [
      `::::synap-section{id="${id}" owner="ai"}`,
      `## ${id}`,
      "",
      body,
      "::::",
    ].join("\n");
  const LIVING = [BODY, aiSection("status", "Two PRs in review."), ""].join(
    "\n"
  );

  async function livingDocument(bound: string | null = AUTOMATION) {
    const id = await newDocument(LIVING);
    await q(`update documents set refresh_automation_id = $1 where id = $2`, [
      bound,
      id,
    ]);
    return id;
  }
  async function runSession(
    opts: { automationId?: string; closed?: boolean; userId?: string } = {}
  ) {
    const id = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, status, metadata, closed_at) values ($1, $2, 'active', $3, $4)`,
      [
        id,
        opts.userId ?? USER,
        JSON.stringify({ automationId: opts.automationId ?? AUTOMATION }),
        opts.closed ? new Date().toISOString() : null,
      ]
    );
    return id;
  }
  const refresh = (
    documentId: string,
    sessionId: string | null,
    ops: unknown[] = [
      {
        op: "upsert_section",
        id: "status",
        title: "status",
        body: "One PR left.",
      },
    ]
  ) =>
    applyDocumentPatch({
      userId: USER,
      agentUserId: AGENT,
      documentId,
      provenanceSessionId: sessionId,
      ops: ops as never,
    });

  it("its run rewriting an existing AI section files under refresher_section_update", async () => {
    const id = await livingDocument();
    await refresh(id, await runSession());
    expect(h.gate.map((g) => g.action)).toEqual(["refresher_section_update"]);
  });

  it("…and where the stored rule applies it, the section is rewritten and the person's is untouched", async () => {
    const id = await livingDocument();
    h.agentAutoApply = true;
    const res = await refresh(id, await runSession());
    expect(res.status).toBe("applied");
    const { content } = await row(id);
    expect(content).toContain("One PR left.");
    expect(content).toContain(human("notes", "My own notes."));
  });

  it("a NEW section from the same run is a section_update (D4 rewrites, never adds)", async () => {
    const id = await livingDocument();
    await refresh(id, await runSession(), [
      { op: "upsert_section", id: "fresh", title: "fresh", body: "New." },
    ]);
    expect(h.gate.map((g) => g.action)).toEqual(["section_update"]);
  });

  it("a NEW section written twice in one patch is still a section_update (judged against the document as read)", async () => {
    // Ops apply in order: the first upsert appends "fresh", so the second
    // REPLACES it in the in-progress text. D4 must judge each op against the
    // sections that existed before the patch, or this pair creates an AI
    // section without review.
    const id = await livingDocument();
    const fresh = {
      op: "upsert_section",
      id: "fresh",
      title: "fresh",
      body: "New.",
    };
    await refresh(id, await runSession(), [fresh, { ...fresh, body: "New!" }]);
    await refresh(id, await runSession(), [
      { op: "upsert_section", id: "status", title: "status", body: "x" },
      fresh,
      { ...fresh, body: "New!" },
    ]);
    expect(h.gate.map((g) => g.action)).toEqual([
      "section_update",
      "section_update",
    ]);
  });

  it("a run of ANOTHER automation, a closed run, someone else's run or no session: section_update", async () => {
    const id = await livingDocument();
    await refresh(
      id,
      await runSession({ automationId: "77777777-7777-4777-8777-777777777777" })
    );
    await refresh(id, await runSession({ closed: true }));
    await refresh(id, await runSession({ userId: "someone-else" }));
    await refresh(id, null);
    expect(h.gate.map((g) => g.action)).toEqual([
      "section_update",
      "section_update",
      "section_update",
      "section_update",
    ]);
  });

  it("a document with no bound refresher: section_update", async () => {
    const id = await livingDocument(null);
    await refresh(id, await runSession());
    expect(h.gate.map((g) => g.action)).toEqual(["section_update"]);
  });

  it("any op beside the section rewrite makes it a document.update", async () => {
    const id = await livingDocument();
    await refresh(id, await runSession(), [
      { op: "upsert_section", id: "status", title: "status", body: "x" },
      { op: "append", body: "More." },
    ]);
    expect(h.gate.map((g) => g.action)).toEqual(["update"]);
  });

  it("the person's section is refused to the refresher like to any agent (the floor runs first)", async () => {
    const id = await livingDocument();
    await expect(
      refresh(id, await runSession(), [
        {
          op: "upsert_section",
          id: "notes",
          title: "notes",
          body: "Mine now.",
        },
      ])
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.gate).toEqual([]);
  });

  it("a session matched only through the run ledger counts (sessionAutomationWhere)", async () => {
    const id = await livingDocument();
    const runId = randomUUID();
    await q(`insert into automation_runs (id, automation_id) values ($1, $2)`, [
      runId,
      AUTOMATION,
    ]);
    const sessionId = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, status, metadata) values ($1, $2, 'active', $3)`,
      [sessionId, USER, JSON.stringify({ automationRunId: runId })]
    );
    await refresh(id, sessionId);
    expect(h.gate.map((g) => g.action)).toEqual(["refresher_section_update"]);
  });
});
