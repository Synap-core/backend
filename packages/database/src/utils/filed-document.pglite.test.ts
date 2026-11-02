/**
 * "Is this a filed document?" on a real Postgres (PGlite): which `documents`
 * rows a document LIST shows and which the search index holds.
 *   - an entity's, view's or skill's body is nobody's filed document: its owner
 *     is listed and indexed, not the body;
 *   - an entity's picture (media copy) is neither listed nor indexed;
 *   - a raw capture is not listed but stays findable; a Library item likewise;
 *   - a row with no metadata is kept by both (NULL never drops a row).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pgTable, text, jsonb } from "drizzle-orm/pg-core";
import { and } from "drizzle-orm";
import {
  filedDocumentWhere,
  indexableDocumentWhere,
  notOwnedDocumentWhere,
} from "./filed-document.js";

const docs = pgTable("docs", {
  id: text("id").primaryKey(),
  metadata: jsonb("metadata"),
});
const pg = new PGlite();
const db = drizzle(pg);
const cols = { id: docs.id, metadata: docs.metadata };

const ROWS: Record<string, unknown> = {
  plain: null,
  noteBody: null,
  whiteboardBody: null,
  skillBody: null,
  picture: { uploadKind: "media-copy", mediaCopyOf: "e1" },
  capture: { intakeSource: { kind: "text" } },
  libraryBuilt: { intakeSource: {}, importItem: { title: "B" } },
  stagedNotLibrary: { intakeSource: { pending: "awaiting_curation" } },
};

beforeAll(async () => {
  // The owner tables, reduced to the one column the predicate reads.
  await pg.exec(`
    create table docs (id text primary key, metadata jsonb);
    create table entities (id serial primary key, document_id text);
    create table views (id serial primary key, document_id text);
    create table skills (id serial primary key, body_document_id text);
    insert into entities (document_id) values ('noteBody'), (null);
    insert into views (document_id) values ('whiteboardBody'), (null);
    insert into skills (body_document_id) values ('skillBody'), (null);
  `);
  for (const [id, m] of Object.entries(ROWS)) {
    await pg.query(`insert into docs values ($1, $2::jsonb)`, [
      id,
      m === null ? null : JSON.stringify(m),
    ]);
  }
});

const ids = async (where: ReturnType<typeof and>) =>
  (await db.select({ id: docs.id }).from(docs).where(where))
    .map((r) => r.id)
    .sort();

describe("filedDocumentWhere / indexableDocumentWhere", () => {
  it("a list shows only the documents someone filed", async () => {
    expect(await ids(filedDocumentWhere(cols))).toEqual(["plain"]);
  });

  it("the index drops every body and picture, keeps Library items and captures", async () => {
    expect(await ids(indexableDocumentWhere(cols))).toEqual([
      "capture",
      "libraryBuilt",
      "plain",
    ]);
  });

  it("each owner table drops its body on its own (a NULL owner column drops nothing)", async () => {
    expect(await ids(notOwnedDocumentWhere(docs.id))).toEqual([
      "capture",
      "libraryBuilt",
      "picture",
      "plain",
      "stagedNotLibrary",
    ]);
  });
});
