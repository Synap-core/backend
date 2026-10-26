-- 0358b: document passages — a document's body as recall-sized units, each with
-- its own vector (recall plan A-W2).
--
-- One vector per entity made a long note one point in space, mostly its
-- header and opening: an answer at char 9,000 was never found. A passage is a
-- section of the stored body, cut by markdown-core `segmentPassages` (sections,
-- ~2,000-char cut, ~400 merge), embedded as "title › heading" + its prose.
--
-- No `user_id` / `workspace_id`: a passage is read only through the entity
-- that owns its document, so the read floor is the entity's, resolved at query
-- time — never a second copy of an ACL to keep in sync.
--
-- `text_hash` = the hash of the text that was embedded: an edit re-embeds only
-- the passages whose text changed. `source_revision` = the
-- `documents.content_revision` the passage was cut from (a citation names it).
--
-- `document_passage_state` is one row per document the worker has read: the
-- revision its passages reflect (also when the body has no passage at all),
-- and the last failure to read the body. The revision sweep compares it with
-- `documents.content_revision`; a body that could not be read keeps its old
-- passages and records why, never "no text".

CREATE TABLE IF NOT EXISTS "document_passages" (
  "id"              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_id"     uuid        NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "ordinal"         integer     NOT NULL,
  "section_id"      text        NOT NULL,
  "heading_path"    text        NOT NULL DEFAULT '',
  "char_start"      integer     NOT NULL,
  "char_end"        integer     NOT NULL,
  "text"            text        NOT NULL,
  "text_hash"       text        NOT NULL,
  "source_revision" integer     NOT NULL,
  "embedding"       vector(1536) NOT NULL,
  "embedding_model" text        NOT NULL DEFAULT 'text-embedding-3-small',
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_document_passages_document_ordinal"
  ON "document_passages" ("document_id", "ordinal");

-- HNSW index for cosine ANN search (pgvector), as on entity_vectors.
CREATE INDEX IF NOT EXISTS "document_passages_embedding_hnsw_idx"
  ON "document_passages" USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS "document_passage_state" (
  "document_id"     uuid        PRIMARY KEY REFERENCES "documents"("id") ON DELETE CASCADE,
  "source_revision" integer,
  "passage_count"   integer     NOT NULL DEFAULT 0,
  "failure"         text,
  "failed_at"       timestamptz,
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);
