/**
 * ONE HTML WRITE DOOR (founder decision, 27 Nov 2026, session 53d7cbed):
 * every entry point that makes an HTML page writes it through the HTML page
 * door (`createHtmlPage`), so every page is stored the same way and refused
 * for the same reasons.
 *
 * Entry points, each driven through its REAL door on PGlite:
 *   - MCP `synap_create_document {type: "html"}` → Hub `documents.createDocument`;
 *   - MCP `synap_create_surface {body: "html"}` → `createSurface`;
 *   - Hub REST `POST /cell-instances/html` → Hub `documents.createDocument`
 *     (`placeAs`), the cell a placement;
 *   - tRPC `cellInstances.createHtmlCell` (a person) → `createHtmlCellInstance`.
 *
 * Asserted on what is STORED (the documents row and the cell row), never on
 * a receipt alone: `type: "html"`, `text/html`, the same `metadata.reads`;
 * the cell holds the page's id (column and props), no content. The same
 * refusals: a page over 2 MB, a declared read outside the ceiling, with no
 * row written. The cell id each cell route returns is one the whiteboard
 * place door resolves. An agent's proposed html cell is a `document/create`
 * proposal whose approval writes the page and places the cell under the id
 * reserved at filing. And the run-time fence: the create door refuses an
 * html body that did not come through the page door.
 *
 * Stubbed, and why: the governance verdict (a switch: granted or proposed;
 * the gate has its own tests, what is pinned here is WHICH gate is asked),
 * `@synap/storage` (an in-memory blob map), the audit log, side effects, the
 * scoped-key middleware, the read-only guard.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID, createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  blobs: new Map<string, string>(),
  verdict: "granted" as "granted" | "proposed",
  gates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: {
      append: async () => ({ id: randomUUID() }),
      emitCompleted: async () => undefined,
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

vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async (opts: Record<string, unknown>) => {
    h.gates.push(opts);
    return h.verdict === "granted"
      ? { granted: true }
      : {
          proposalId: randomUUID(),
          proposalType: "create",
          summary: "Create a page",
          reasoning: "test",
          reviewPath: "/proposals/x",
        };
  }),
}));
vi.mock("../middleware/api-key-auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../middleware/api-key-auth.js")>();
  const { t } =
    await vi.importActual<typeof import("../trpc.js")>("../trpc.js");
  return { ...actual, scopedProcedure: () => t.procedure };
});
vi.mock("../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(async () => undefined),
}));
vi.mock("../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import {
  createDocumentWithContent,
  createHtmlPage,
  db,
  eventRepository,
  HTML_PAGE_MAX_BYTES,
} from "@synap/database";
import { pgliteAllTablesDdl } from "../__tests__/pglite-ddl.js";
import { documentsRouter as hubDocumentsRouter } from "./hub-protocol/documents.js";
import { entityHandlers } from "./mcp/handlers/entity.js";
import { buildHandlers } from "./mcp/handlers/build.js";
import type { McpToolContext } from "./mcp/handlers/shared.js";
import { cellInstancesRouter } from "./cell-instances.js";
import { registerCellInstancesRoutes } from "./hub-protocol/rest/cell-instances.js";
import type { HubHono, HubVariables } from "./hub-protocol/rest/_shared.js";
import { resolveBoardReferences } from "../services/whiteboards/place-on-board.js";
import { proposalExecRegistry } from "./proposals/execution-registry.js";
import { registerDocumentExecutors } from "./proposals/executors/document.js";
import {
  insertCellInstance,
  placeHtmlPage,
} from "../services/cells/create-cell-instance.js";

const OWNER = randomUUID();
const WS = randomUUID();
/** Another space of OWNER, and another person (review of backend#1357). */
const WS_X = randomUUID();
const OTHER = randomUUID();

/** A declared read inside the ceiling, and one outside it. */
const READS = [{ op: "entities.get" }];
const BAD_READS = [{ op: "entities.delete" }];
const PAGE = "<!doctype html><html><body><h1>Pipeline</h1></body></html>";
const BIG = `<p>${"x".repeat(HTML_PAGE_MAX_BYTES)}</p>`;

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const count = async (table: "documents" | "cell_instances") =>
  (await q<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!
    .n;

type StoredPage = {
  type: string;
  mime_type: string;
  metadata: Record<string, unknown> | null;
};
async function pageOf(id: string): Promise<StoredPage> {
  const { rows } = await q<StoredPage>(
    `select type, mime_type, metadata from documents where id = $1`,
    [id]
  );
  expect(rows, `no document ${id}`).toHaveLength(1);
  return rows[0]!;
}

type StoredCell = {
  cell_type: string;
  source_document_id: string | null;
  config: Record<string, unknown>;
};
async function cellOf(id: string): Promise<StoredCell> {
  const { rows } = await q<StoredCell>(
    `select cell_type, source_document_id, config from cell_instances where id = $1`,
    [id]
  );
  expect(rows, `no cell ${id}`).toHaveLength(1);
  return rows[0]!;
}

function mcpCtx(toolName: string, args: Record<string, unknown>) {
  const caller = {
    documents: hubDocumentsRouter.createCaller({
      userId: OWNER,
      scopes: [],
    } as never),
  };
  return {
    toolName,
    args,
    userId: OWNER,
    apiKeyScopes: ["mcp.read", "mcp.write"],
    caller,
    lensCaller: caller,
    requestedWorkspaceId: WS,
    workspaceAccessible: true,
  } as unknown as McpToolContext;
}

function mcpJson(result: unknown): Record<string, unknown> {
  const r = result as { isError?: boolean; content: Array<{ text?: string }> };
  const text = r.content[0]!.text!;
  if (r.isError) throw new Error(text);
  return JSON.parse(text) as Record<string, unknown>;
}

function hubApp() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", async (c, next) => {
    c.set("userId" as never, OWNER as never);
    c.set("scopes" as never, ["hub-protocol.write"] as never);
    c.set("keyType" as never, "hub_inbound" as never);
    await next();
  });
  registerCellInstancesRoutes(hub);
  return hub;
}

async function hubPost(body: Record<string, unknown>) {
  const res = await hubApp().request("/cell-instances/html", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

/** One entry point: make a page; the stored document id (and cell id). */
type Made = { documentId: string; cellId?: string };
const ENTRY_POINTS: Record<
  string,
  (content: string, reads?: unknown) => Promise<Made>
> = {
  "MCP synap_create_document": async (content, reads) => {
    const out = mcpJson(
      await entityHandlers.synap_create_document!(
        mcpCtx("synap_create_document", {
          title: "Pipeline page",
          content,
          type: "html",
          ...(reads !== undefined ? { reads } : {}),
        })
      )
    );
    expect(out.status).toBe("created");
    return { documentId: out.documentId as string };
  },
  "MCP synap_create_surface": async (content, reads) => {
    const out = mcpJson(
      await buildHandlers.synap_create_surface!(
        mcpCtx("synap_create_surface", {
          anchor: { kind: "workspace", id: WS },
          body: "html",
          title: "Pipeline page",
          spec: { content, ...(reads !== undefined ? { reads } : {}) },
        })
      )
    );
    expect(out.status).toBe("created");
    return { documentId: (out.surface as { id: string }).id };
  },
  "Hub POST /cell-instances/html": async (content, reads) => {
    const res = await hubPost({
      workspaceId: WS,
      html: content,
      name: "Pipeline page",
      ...(reads !== undefined ? { reads } : {}),
    });
    if (res.status !== 200)
      throw new Error(`${res.status}: ${String(res.body.error ?? "")}`);
    return {
      documentId: res.body.sourceDocumentId as string,
      cellId: res.body.id as string,
    };
  },
  "tRPC cellInstances.createHtmlCell": async (content, reads) => {
    const row = await cellInstancesRouter
      .createCaller({
        authenticated: true,
        userId: OWNER,
        workspaceId: WS,
      } as never)
      .createHtmlCell({
        html: content,
        name: "Pipeline page",
        ...(reads !== undefined ? { reads } : {}),
      });
    return { documentId: row.sourceDocumentId!, cellId: row.id };
  },
};

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  await h.client!.exec(
    `create unique index on links (from_type, from_id, to_type, to_id, link_type)`
  );
  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    OWNER,
    "owner@example.test",
  ]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Sales',$2,'{}'::jsonb)`,
    [WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, OWNER]
  );
  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    OTHER,
    "other@example.test",
  ]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Finance',$2,'{}'::jsonb)`,
    [WS_X, OWNER]
  );
  registerDocumentExecutors();
}, 120_000);

beforeEach(() => {
  h.verdict = "granted";
  h.gates.length = 0;
});

describe("every HTML entry point writes through the ONE page door", () => {
  for (const [name, make] of Object.entries(ENTRY_POINTS)) {
    it(`${name}: stored as an html page with its declared reads`, async () => {
      // A distinct page per entry point (the document door's content
      // idempotency would otherwise answer with an earlier page).
      const made = await make(PAGE.replace("Pipeline", name), READS);
      const page = await pageOf(made.documentId);
      expect(page.type).toBe("html");
      expect(page.mime_type).toBe("text/html");
      expect(page.metadata?.reads).toEqual(READS);
      if (made.cellId) {
        // The cell is a PLACEMENT: it points at the page, holds no content.
        const cell = await cellOf(made.cellId);
        expect(cell.cell_type).toBe("html-embed");
        expect(cell.source_document_id).toBe(made.documentId);
        expect(cell.config).toEqual({ sourceDocumentId: made.documentId });
      }
    });
  }

  for (const [name, make] of Object.entries(ENTRY_POINTS)) {
    it(`${name}: refuses a page over 2 MB and a read outside the ceiling, writing nothing`, async () => {
      const docs = await count("documents");
      const cells = await count("cell_instances");
      await expect(make(BIG)).rejects.toThrow(/at most 2097152 bytes/);
      await expect(make(PAGE, BAD_READS)).rejects.toThrow(
        /"entities\.delete" is not a frame read/
      );
      expect(await count("documents")).toBe(docs);
      expect(await count("cell_instances")).toBe(cells);
      // Refused BEFORE governance: nothing was filed either.
      expect(h.gates).toEqual([]);
    });
  }
});

describe("the cell routes still hand back a cell the place door accepts", () => {
  for (const name of [
    "Hub POST /cell-instances/html",
    "tRPC cellInstances.createHtmlCell",
  ]) {
    it(`${name}: its cell id resolves on a board of its space`, async () => {
      const made = await ENTRY_POINTS[name]!(
        PAGE.replace("Pipeline", `${name} board`)
      );
      const resolved = await resolveBoardReferences(
        [
          {
            kind: "cellInstance",
            cellInstanceId: made.cellId!,
            cellKey: "html-embed",
          },
        ],
        { userId: OWNER, boardWorkspaceId: WS }
      );
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        kind: "cellInstance",
        cellInstanceId: made.cellId,
      });
    });
  }
});

describe("an agent's html cell is a document proposal; its approval places the cell", () => {
  it("Hub POST /cell-instances/html, proposed: the DOCUMENT door's gate, nothing written until approval", async () => {
    h.verdict = "proposed";
    const docs = await count("documents");
    const cells = await count("cell_instances");
    const res = await hubPost({
      workspaceId: WS,
      html: PAGE.replace("Pipeline", "Proposed"),
      name: "Proposed page",
      reads: READS,
    });
    // The governed reply: 202 Accepted (`jsonGoverned`), as before.
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("proposed");
    expect(typeof res.body.proposalId).toBe("string");
    expect(h.gates).toHaveLength(1);
    const gate = h.gates[0]!;
    expect(gate).toMatchObject({ subjectType: "document", action: "create" });
    const data = gate.data as Record<string, unknown>;
    expect(data).toMatchObject({ type: "html", reads: READS });
    const placeAs = data.placeAs as { kind: string; cellId: string };
    expect(placeAs.kind).toBe("html-embed-cell");
    expect(await count("documents")).toBe(docs);
    expect(await count("cell_instances")).toBe(cells);

    // The person approves the proposal as filed.
    const proposalId = randomUUID();
    const result = await proposalExecRegistry
      .resolveExact("document/create")!
      .execute({
        proposal: {
          id: proposalId,
          workspaceId: WS,
          targetId: data.id,
          subjectUserId: OWNER,
          data: { data },
        },
        payload: null,
        userId: OWNER,
        input: { proposalId },
        ctx: {},
        deps: {
          emitProposalReviewed: vi.fn(),
          reportProposalOutcome: vi.fn(),
        },
      } as never);
    expect(result).toMatchObject({ success: true, primaryId: data.id });
    const page = await pageOf(data.id as string);
    expect(page.type).toBe("html");
    expect(page.metadata?.reads).toEqual(READS);
    const cell = await cellOf(placeAs.cellId);
    expect(cell.source_document_id).toBe(data.id);
    expect(cell.config).toEqual({ sourceDocumentId: data.id });
  });
});

describe("the run-time fence: no html body outside the page door", () => {
  for (const shape of [
    { type: "html", mimeType: "text/html" },
    { type: "text", mimeType: "text/html" },
  ]) {
    it(`createDocumentWithContent refuses ${shape.type} + ${shape.mimeType} without the door`, async () => {
      const docs = await count("documents");
      await expect(
        createDocumentWithContent(db, eventRepository, {
          ownerUserId: OWNER,
          workspaceId: WS,
          title: "Smuggled page",
          content: PAGE,
          ...shape,
          provenance: { createdByKind: "human" },
        })
      ).rejects.toThrow(/only through createHtmlPage/);
      expect(await count("documents")).toBe(docs);
    });
  }
});

/**
 * Review of backend#1357. A placement is only ever of the placer's OWN html
 * page of the space the cell lands in; the cell id is the server's; an
 * approval that fails part-way leaves nothing behind and can run again.
 *
 * The confined key is simulated by its effect: the scoped-key middleware is
 * stubbed (see the header), so a caller in space WS (its key's space) names a
 * page of WS_X through `proposedDocumentId`, the replay path.
 */
describe("a placement is of the caller's own html page of the space, under the server's id", () => {
  const hubDocs = () =>
    hubDocumentsRouter.createCaller({ userId: OWNER, scopes: [] } as never);
  const pageIn = (workspaceId: string, ownerUserId: string, title: string) =>
    createHtmlPage(db, eventRepository, {
      ownerUserId,
      workspaceId,
      title,
      content: PAGE.replace("Pipeline", title),
      provenance: { createdByKind: "human" },
    });
  const cellsOf = async (documentId: string) =>
    (
      await q<{ id: string }>(
        `select id from cell_instances where source_document_id = $1`,
        [documentId]
      )
    ).rows;
  const approve = (data: Record<string, unknown>, proposalId: string) =>
    proposalExecRegistry.resolveExact("document/create")!.execute({
      proposal: {
        id: proposalId,
        workspaceId: WS,
        targetId: data.id,
        subjectUserId: OWNER,
        data: { data },
      },
      payload: null,
      userId: OWNER,
      input: { proposalId },
      ctx: {},
      deps: {
        emitProposalReviewed: vi.fn(),
        reportProposalOutcome: vi.fn(),
      },
    } as never) as Promise<Record<string, unknown>>;
  /** A page filed as a proposal through the cell route; its stored data. */
  const filed = async (title: string) => {
    h.verdict = "proposed";
    const res = await hubPost({
      workspaceId: WS,
      html: PAGE.replace("Pipeline", title),
      name: title,
    });
    expect(res.status).toBe(202);
    const data = h.gates.at(-1)!.data as Record<string, unknown>;
    h.verdict = "granted";
    return data;
  };

  it("a key of space WS naming a page of space WS_X (placeAs + proposedDocumentId): refused, no cell", async () => {
    const pageX = await pageIn(WS_X, OWNER, "Finance page");
    const cells = await count("cell_instances");
    await expect(
      hubDocs().createDocument({
        userId: OWNER,
        workspaceId: WS,
        title: "Finance page",
        content: PAGE,
        type: "html",
        proposedDocumentId: pageX.id,
        placeAs: { kind: "html-embed-cell", cellId: randomUUID() },
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/cannot be placed as a cell here/),
    });
    expect(await count("cell_instances")).toBe(cells);
    expect(await cellsOf(pageX.id)).toEqual([]);
  });

  it("a page that is not html: refused, no cell", async () => {
    const md = await createDocumentWithContent(db, eventRepository, {
      ownerUserId: OWNER,
      workspaceId: WS,
      title: "Plain notes",
      content: "# Notes",
      type: "markdown",
      mimeType: "text/markdown",
      provenance: { createdByKind: "human" },
    });
    const cells = await count("cell_instances");
    await expect(
      hubDocs().createDocument({
        userId: OWNER,
        workspaceId: WS,
        title: "Plain notes",
        content: PAGE,
        type: "html",
        proposedDocumentId: md.id,
        placeAs: { kind: "html-embed-cell" },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      placeHtmlPage({ documentId: md.id, workspaceId: WS, userId: OWNER })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await count("cell_instances")).toBe(cells);
    expect(await cellsOf(md.id)).toEqual([]);
  });

  it("another person's page: refused, no cell", async () => {
    const theirs = await pageIn(WS, OTHER, "Their page");
    const cells = await count("cell_instances");
    await expect(
      placeHtmlPage({ documentId: theirs.id, workspaceId: WS, userId: OWNER })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Through the door: their id is not ours to reuse, a fresh page is made
    // and placed; theirs is never placed.
    const out = await hubDocs().createDocument({
      userId: OWNER,
      workspaceId: WS,
      title: "Their page",
      content: PAGE.replace("Pipeline", "Not theirs"),
      type: "html",
      proposedDocumentId: theirs.id,
      placeAs: { kind: "html-embed-cell" },
    });
    expect(out.documentId).not.toBe(theirs.id);
    expect(await cellsOf(theirs.id)).toEqual([]);
    expect(await count("cell_instances")).toBe(cells + 1);
  });

  it("the same refusal for every case: no page, another space, another person, not html", async () => {
    const pageX = await pageIn(WS_X, OWNER, "Finance page 2");
    const theirs = await pageIn(WS, OTHER, "Their page 2");
    const messages = await Promise.all(
      [randomUUID(), pageX.id, theirs.id].map((documentId) =>
        placeHtmlPage({ documentId, workspaceId: WS, userId: OWNER }).then(
          () => "placed",
          (e: Error) => e.message
        )
      )
    );
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toMatch(/cannot be placed as a cell here/);
  });

  it("a placement that fails on approval leaves no page; the proposal approves cleanly again", async () => {
    const data = await filed("Failing placement");
    const placeAs = data.placeAs as { cellId: string };
    const docs = await count("documents");
    const cells = await count("cell_instances");
    const proposalId = randomUUID();
    await h.client!.exec(`
      create or replace function fail_cell_insert() returns trigger
        language plpgsql as $$ begin raise exception 'cell insert failed (test)'; end $$;
      create trigger fail_cell_insert before insert on cell_instances
        for each row execute function fail_cell_insert();
    `);
    try {
      // drizzle wraps the trigger's error: "Failed query: insert into …".
      await expect(approve(data, proposalId)).rejects.toThrow(
        /insert into "cell_instances"/
      );
    } finally {
      await h.client!.exec(
        `drop trigger if exists fail_cell_insert on cell_instances`
      );
    }
    // No orphan page, nothing placed.
    expect(await count("documents")).toBe(docs);
    expect(await count("cell_instances")).toBe(cells);
    // Approved again: the page and its cell, once each.
    const result = await approve(data, proposalId);
    expect(result).toMatchObject({ success: true, primaryId: data.id });
    expect(await count("documents")).toBe(docs + 1);
    expect((await cellOf(placeAs.cellId)).source_document_id).toBe(data.id);
  });

  it("an approval run again after it wrote the page: reuses it, never a duplicate-id failure", async () => {
    const data = await filed("Approved twice");
    const proposalId = randomUUID();
    const first = await approve(data, proposalId);
    const docs = await count("documents");
    const cells = await count("cell_instances");
    const again = await approve(data, proposalId);
    expect(again).toMatchObject({ success: true, primaryId: data.id });
    expect((again.effect as { ids: string[] }).ids).toEqual(
      (first.effect as { ids: string[] }).ids
    );
    expect(await count("documents")).toBe(docs);
    expect(await count("cell_instances")).toBe(cells);
  });

  it("a caller-chosen cell id naming an existing cell leaks nothing", async () => {
    const foreignId = randomUUID();
    await insertCellInstance({
      id: foreignId,
      workspaceId: WS_X,
      userId: OTHER,
      cellType: "html-embed",
    });
    const foreignBefore = await cellOf(foreignId);

    // Applied at once: the caller's id is ignored; the server's is used.
    const out = await hubDocs().createDocument({
      userId: OWNER,
      workspaceId: WS,
      title: "Chosen id",
      content: PAGE.replace("Pipeline", "Chosen id"),
      type: "html",
      placeAs: { kind: "html-embed-cell", cellId: foreignId },
    });
    expect(out.status).toBe("created");
    const placedId = (out as { cellInstanceId?: string }).cellInstanceId!;
    expect(placedId).toBeTruthy();
    expect(placedId).not.toBe(foreignId);
    expect((await cellOf(placedId)).source_document_id).toBe(out.documentId);

    // Proposed: the proposal carries the server's id, never the caller's.
    h.verdict = "proposed";
    await hubDocs().createDocument({
      userId: OWNER,
      workspaceId: WS,
      title: "Chosen id, proposed",
      content: PAGE.replace("Pipeline", "Chosen id, proposed"),
      type: "html",
      placeAs: { kind: "html-embed-cell", cellId: foreignId },
    });
    const data = h.gates.at(-1)!.data as Record<string, unknown>;
    h.verdict = "granted";
    expect((data.placeAs as { cellId: string }).cellId).not.toBe(foreignId);

    // A proposal filed before the server reserved ids, naming that cell: its
    // approval places the page under a fresh id, and says nothing of it.
    const old = {
      ...data,
      placeAs: { ...(data.placeAs as object), cellId: foreignId },
    };
    const result = await approve(old, randomUUID());
    expect(result).toMatchObject({ success: true, primaryId: data.id });
    const [, cellIdPlaced] = (result.effect as { ids: string[] }).ids;
    expect(cellIdPlaced).not.toBe(foreignId);
    expect((await cellOf(cellIdPlaced!)).source_document_id).toBe(data.id);
    expect(await cellOf(foreignId)).toEqual(foreignBefore);
  });
});
