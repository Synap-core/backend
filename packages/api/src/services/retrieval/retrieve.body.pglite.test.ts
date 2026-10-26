/**
 * `fetchOrdered` attaches each entity's CURRENT document body, not the last
 * checkpoint (plan-recall A-W1, evidence c453a66b).
 *
 * The `document_versions` row of `documents.current_version` is only the last
 * CHECKPOINT: a person's saves cut no row, so an answer synthesized from it
 * missed every edit since. The stored body (`loadDocumentBodyTexts`) is what
 * the document says now. Pinned:
 *  - an edited body with no new checkpoint reads as the EDITED text;
 *  - a body that cannot be read is `contentReadError`, never "no content";
 *  - an entity with no document gets neither.
 *
 * Real: `fetchOrdered`, `loadDocumentBodyTexts`, the entities read on PGlite.
 * Stubbed, and why: `@synap/storage` (an in-memory blob map);
 * `loadFacetSlugsBatch` and `listableEntityWhere` (their own tests cover them;
 * neither decides the body).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
  },
  blobs: new Map<string, string>(),
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
        entities: schema.entities,
        documents: schema.documents,
        documentVersions: schema.documentVersions,
      } as never,
    }),
    loadFacetSlugsBatch: async () => new Map(),
    listableEntityWhere: () => sql`true`,
  };
});

vi.mock("@synap/storage", () => ({
  storage: {
    downloadBuffer: async (key: string) => {
      const body = h.blobs.get(key);
      if (body === undefined) throw new Error(`storage unreachable for ${key}`);
      return Buffer.from(body, "utf-8");
    },
  },
}));

const schema = await import("@synap/database/schema");
const { fetchOrdered } = await import("./retrieve.js");

const USER = "user-1";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (text: string, params?: unknown[]) => h.client!.query(text, params);

/** An entity whose document has a checkpoint row and, optionally, a stored body. */
async function seedNote(opts: {
  checkpoint: string;
  storedBody?: string;
}): Promise<string> {
  const entityId = randomUUID();
  const documentId = randomUUID();
  const storageKey = `${USER}/document/${documentId}.md`;
  if (opts.storedBody !== undefined) h.blobs.set(storageKey, opts.storedBody);
  await q(
    `insert into documents (id, user_id, title, type, storage_key, mime_type, current_version, last_saved_version, content_revision)
     values ($1, $2, 'Note', 'markdown', $3, 'text/markdown', 1, 1, 2)`,
    [documentId, USER, storageKey]
  );
  await q(
    `insert into document_versions (id, document_id, version, content, author, author_id)
     values ($1, $2, 1, $3, 'user', $4)`,
    [randomUUID(), documentId, opts.checkpoint, USER]
  );
  await q(
    `insert into entities (id, user_id, type, title, document_id) values ($1, $2, 'note', 'Note', $3)`,
    [entityId, USER, documentId]
  );
  return entityId;
}

beforeAll(async () => {
  for (const t of [
    schema.entities,
    schema.documents,
    schema.documentVersions,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
}, 60_000);

describe("fetchOrdered — the entity body is the document's CURRENT body", () => {
  it("an edited body with no new checkpoint reads as the edited text", async () => {
    const id = await seedNote({
      checkpoint: "# Pricing\n\nThe seat price is 39 EUR.",
      storedBody: "# Pricing\n\nThe seat price is 49 EUR (changed Monday).",
    });
    const [row] = await fetchOrdered([id], USER, null, {} as never);
    expect(row!.content).toContain("49 EUR");
    expect(row!.content).not.toContain("39 EUR");
    // Markdown is kept: synthesis cuts a long body at its headings.
    expect(row!.content).toMatch(/^# Pricing/);
  });

  it("a body that cannot be read is reported, never read as no content", async () => {
    const id = await seedNote({ checkpoint: "stale text" });
    const [row] = await fetchOrdered([id], USER, null, {} as never);
    expect(row!.content).toBeUndefined();
    expect(row!.contentReadError).toMatch(/storage unreachable/);
  });

  it("an entity with no document gets neither field", async () => {
    const id = randomUUID();
    await q(
      `insert into entities (id, user_id, type, title) values ($1, $2, 'note', 'Bare')`,
      [id, USER]
    );
    const [row] = await fetchOrdered([id], USER, null, {} as never);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("content");
    expect(row).not.toHaveProperty("contentReadError");
  });
});
