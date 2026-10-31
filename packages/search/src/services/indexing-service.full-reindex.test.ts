/**
 * A full reindex writes each entity as the incremental index does: its summary
 * in `description` and its linked document body in `content`. Before, it wrote
 * entities with no body at all, so the reindex that backfills a new indexer
 * (`SEARCH_INDEX_VERSIONS`, queued at boot) would have wiped every note's text.
 *
 * Real IndexingService + EntityIndexer; the database reads and Typesense are
 * stand-ins at their boundary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  entityRows: [] as Array<Record<string, unknown>>,
  bodies: {
    texts: new Map<string, string>(),
    failed: new Map<string, string>(),
  },
  bodyCalls: [] as string[][],
  imported: [] as Array<Record<string, unknown>>,
  indexedIds: [] as string[],
  deleted: [] as string[],
  // What the `documents` reads were asked for (the `where` they passed).
  documentWheres: [] as unknown[],
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  getDb: async () => ({
    query: {
      entities: { findMany: async () => h.entityRows },
      documents: {
        findMany: async (opts: { where: unknown }) => {
          h.documentWheres.push(opts.where);
          return [];
        },
      },
    },
    // loadActiveFacetWorkspaceIds: no facets.
    select: () => ({ from: () => ({ where: async () => [] }) }),
  }),
  loadAllFacetSlugsBatchForTrustedIndexing: async () => new Map(),
  loadDocumentBodyTexts: async (_db: unknown, ids: string[]) => {
    h.bodyCalls.push(ids);
    return h.bodies;
  },
}));

vi.mock("../client.js", () => ({
  getTypesenseAdminClient: () => ({
    collections: () => ({
      documents: (id?: string) => ({
        import: async (docs: Array<Record<string, unknown>>) => {
          h.imported.push(...docs);
          return docs.map(() => ({ success: true }));
        },
        export: async () =>
          h.indexedIds.map((i) => JSON.stringify({ id: i })).join("\n"),
        delete: async () => {
          h.deleted.push(id as string);
        },
      }),
    }),
  }),
}));

import { IndexingService } from "./indexing-service.js";

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  preview: null,
  documentId: null,
  userId: "u1",
  workspaceId: "ws-1",
  projectId: null,
  type: "note",
  tags: null,
  status: null,
  properties: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...extra,
});

beforeEach(() => {
  h.entityRows = [];
  h.bodies = { texts: new Map(), failed: new Map() };
  h.bodyCalls = [];
  h.imported = [];
  h.indexedIds = [];
  h.deleted = [];
  h.documentWheres = [];
});

describe("fullReindex('entities')", () => {
  it("writes the summary and the linked document body", async () => {
    h.entityRows = [
      row("note", {
        preview: "Current pricing from the control plane",
        documentId: "doc-1",
      }),
    ];
    h.bodies.texts.set("doc-1", "Backfill of autoApproveFor at rung 2.8");

    const result = await new IndexingService().fullReindex(["entities"]);

    expect(result.entities).toEqual({ upserted: 1, deleted: 0 });
    expect(h.imported).toHaveLength(1);
    expect(h.imported[0].description).toBe(
      "Current pricing from the control plane"
    );
    expect(h.imported[0].content).toContain("autoApproveFor");
  });

  it("keeps the entry of a row whose body could not be read: not rewritten, not pruned", async () => {
    h.entityRows = [
      row("readable", { documentId: "doc-1" }),
      row("unreadable", { documentId: "doc-2" }),
    ];
    h.bodies.texts.set("doc-1", "text");
    h.bodies.failed.set("doc-2", "storage timeout");
    h.indexedIds = ["readable", "unreadable", "gone"];

    const result = await new IndexingService().fullReindex(["entities"]);

    expect(h.imported.map((d) => d.id)).toEqual(["readable"]);
    expect(h.deleted).toEqual(["gone"]);
    expect(result.entities.error).toBeUndefined();
  });

  it("reads bodies a batch at a time", async () => {
    h.entityRows = Array.from({ length: 450 }, (_, i) =>
      row(`e${i}`, { documentId: `d${i}` })
    );

    await new IndexingService().fullReindex(["entities"]);

    expect(h.bodyCalls.map((c) => c.length)).toEqual([200, 200, 50]);
    expect(h.imported).toHaveLength(450);
  });
});

describe("what the `documents` index reads", () => {
  // The rendered SQL of the `where` a documents read passed. The rule itself
  // is proven on a real Postgres (`filed-document.pglite.test.ts`); this proves
  // BOTH index paths reach it, so a body can never be indexed as a document.
  const render = async (where: unknown): Promise<string> => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const orm = await import("drizzle-orm");
    const { documents } = await import("@synap/database/schema");
    const sql =
      typeof where === "function"
        ? (where as (d: unknown, ops: unknown) => unknown)(documents, orm)
        : where;
    return new PgDialect().sqlToQuery(sql as never).sql;
  };

  it("a full reindex leaves out another row's body (entity, view, skill)", async () => {
    await new IndexingService().fullReindex(["documents"]);
    const sql = await render(h.documentWheres[0]);
    expect(sql).toContain("entities.document_id");
    expect(sql).toContain("views.document_id");
    expect(sql).toContain("skills.body_document_id");
  });

  it("an incremental index of one document leaves them out too", async () => {
    await new IndexingService().indexNow({
      collection: "documents",
      operation: "upsert",
      documentId: "d1",
      timestamp: 0,
    });
    const sql = await render(h.documentWheres[0]);
    expect(sql).toContain("entities.document_id");
  });
});
