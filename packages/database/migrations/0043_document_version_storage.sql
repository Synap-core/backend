-- Migration 0043: canonical storage-backed document versions
--
-- New document versions store their immutable snapshot content in MinIO/R2,
-- mirroring documents.storage_key for current content. The existing `content`
-- column stays in place for legacy rows and small previews so old data remains
-- readable while new code prefers storage_key.

ALTER TABLE "document_versions"
  ADD COLUMN IF NOT EXISTS "storage_url" text;

ALTER TABLE "document_versions"
  ADD COLUMN IF NOT EXISTS "storage_key" text;

ALTER TABLE "document_versions"
  ADD COLUMN IF NOT EXISTS "size" integer NOT NULL DEFAULT 0;

ALTER TABLE "document_versions"
  ADD COLUMN IF NOT EXISTS "mime_type" text;

ALTER TABLE "document_versions"
  ADD COLUMN IF NOT EXISTS "checksum" text;

CREATE INDEX IF NOT EXISTS "document_versions_storage_key_idx"
  ON "document_versions" ("storage_key");
