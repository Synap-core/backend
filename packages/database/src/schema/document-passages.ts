/**
 * Document Passages — a document's body as recall-sized units (migration 0358).
 *
 * One vector per entity made a long note one point in space, mostly its header
 * and opening. A passage is one section of the STORED body, cut by
 * markdown-core `segmentPassages` and embedded on its own, so a question
 * answered deep in a note can find it (recall plan A-W2; the recall leg is
 * A-W3).
 *
 * No user/workspace column: a passage is read only through the entity that
 * owns its document (`entities.document_id`), whose floor applies at query
 * time. Written only by the `document-passages` worker
 * (`jobs/workers/document-passages.ts`).
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  vector,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { documents } from "./documents.js";

export const documentPassages = pgTable(
  "document_passages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** 0-based position in the document. */
    ordinal: integer("ordinal").notNull(),
    /** The splitter's stable passage id (the section's slug, `-part-N`). */
    sectionId: text("section_id").notNull(),
    /** The section heading(s) the passage sits under. */
    headingPath: text("heading_path").notNull().default(""),
    /** Offsets in the stored markdown. */
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    /** The passage as prose (markdown-core `markdownToPlainText`). */
    text: text("text").notNull(),
    /** Hash of the text that was embedded: an unchanged passage keeps its vector. */
    textHash: text("text_hash").notNull(),
    /** The `documents.content_revision` this passage was cut from. */
    sourceRevision: integer("source_revision").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    embeddingModel: text("embedding_model")
      .default("text-embedding-3-small")
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    // HNSW index for cosine ANN search defined in migration SQL (Drizzle doesn't support HNSW syntax yet)
  },
  (table) => ({
    documentOrdinalUnique: uniqueIndex(
      "uq_document_passages_document_ordinal"
    ).on(table.documentId, table.ordinal),
  })
);

/**
 * One row per document the passage worker has read: the revision its passages
 * reflect (also when the body yields none) and the last failure to read the
 * body. The revision sweep compares `sourceRevision` with
 * `documents.content_revision`.
 */
export const documentPassageState = pgTable("document_passage_state", {
  documentId: uuid("document_id")
    .primaryKey()
    .references(() => documents.id, { onDelete: "cascade" }),
  /** NULL = never built (the first read failed). */
  sourceRevision: integer("source_revision"),
  passageCount: integer("passage_count").notNull().default(0),
  /** Why the last read of the body failed; NULL after a successful build. */
  failure: text("failure"),
  failedAt: timestamp("failed_at", { mode: "date", withTimezone: true }),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type DocumentPassage = typeof documentPassages.$inferSelect;
export type NewDocumentPassage = typeof documentPassages.$inferInsert;
export type DocumentPassageState = typeof documentPassageState.$inferSelect;
