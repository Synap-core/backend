/**
 * The list exclusion on PGlite, over the REAL metadata shapes: a media copy
 * (the body door's defaults + the copy's mark), a plain upload, a row with no
 * metadata, and a Library item. Only the copy is left out.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pgTable, text, jsonb } from "drizzle-orm/pg-core";
import {
  MEDIA_COPY_UPLOAD_KIND,
  notMediaCopyDocumentWhere,
} from "../media-copy-documents.js";

const docs = pgTable("docs", { id: text("id"), metadata: jsonb("metadata") });
const client = new PGlite();
const db = drizzle(client);

beforeAll(async () => {
  await client.exec(`create table docs (id text, metadata jsonb)`);
  await client.query(
    `insert into docs values ($1,$2),($3,$4),($5,null),($6,$7)`,
    [
      "copy",
      JSON.stringify({
        originalFileName: "a.png",
        uploadKind: MEDIA_COPY_UPLOAD_KIND,
        mediaCopyOf: "e1",
      }),
      "upload",
      JSON.stringify({ originalFileName: "b.png", uploadKind: "file-upload" }),
      "bare",
      "library",
      JSON.stringify({ importItem: { id: "x" } }),
    ]
  );
});

describe("notMediaCopyDocumentWhere", () => {
  it("leaves out exactly the media copies (NULL metadata is kept)", async () => {
    const rows = await db
      .select({ id: docs.id })
      .from(docs)
      .where(notMediaCopyDocumentWhere(docs.metadata));
    expect(rows.map((r) => r.id).sort()).toEqual(["bare", "library", "upload"]);
  });
});
