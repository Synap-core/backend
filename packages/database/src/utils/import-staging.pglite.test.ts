/**
 * The intake predicates on a real Postgres (PGlite): which documents a
 * capture/document LIST shows, and which the search index holds.
 *   - a Library item (`importItem`) is never a list row, before or after Build;
 *   - it IS indexed for search from the moment it is kept (decision 4);
 *   - a staged source that is not a Library item stays out of both;
 *   - a row with no metadata is kept by both (NULL never drops a row).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pgTable, text, jsonb } from "drizzle-orm/pg-core";
import { and } from "drizzle-orm";
import {
  notLibraryItemWhere,
  notStagedImportItemWhere,
  searchIndexableDocumentWhere,
} from "./import-staging.js";

const docs = pgTable("docs", {
  id: text("id").primaryKey(),
  metadata: jsonb("metadata"),
});
const pg = new PGlite();
const db = drizzle(pg);

const ROWS: Record<string, unknown> = {
  plain: null,
  capture: { intakeSource: { kind: "text" } },
  libraryStaged: {
    intakeSource: { pending: "awaiting_curation" },
    importItem: { title: "A" },
  },
  libraryBuilt: { intakeSource: {}, importItem: { title: "B" } },
  stagedNotLibrary: { intakeSource: { pending: "awaiting_curation" } },
};

beforeAll(async () => {
  await pg.exec(`create table docs (id text primary key, metadata jsonb)`);
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

describe("intake predicates", () => {
  it("lists never show a Library item, staged or built", async () => {
    expect(
      await ids(
        and(
          notStagedImportItemWhere(docs.metadata),
          notLibraryItemWhere(docs.metadata)
        )
      )
    ).toEqual(["capture", "plain"]);
  });

  it("search indexes every Library item, and nothing else that is staged", async () => {
    expect(await ids(and(searchIndexableDocumentWhere(docs.metadata)))).toEqual(
      ["capture", "libraryBuilt", "libraryStaged", "plain"]
    );
  });
});
