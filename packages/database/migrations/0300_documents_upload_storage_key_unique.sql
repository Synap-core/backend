-- 0300 — one documents row per PRESIGNED-UPLOAD object.
--
-- The presigned upload lane (`file-upload-presign.ts`) adopts an object the
-- client PUT straight to storage, under a key it minted:
-- `files/<workspaceId>/uploads/<userId>/<uuid>/<name>`. Finalize refuses a key
-- whose document is already claimed, but two concurrent finalizes of the same
-- key could each pass that probe and write two rows over ONE object — deleting
-- either would then delete the other's bytes. This index closes that race; the
-- loser's insert 23505s and finalize answers 409.
--
-- SCOPED to the upload namespace on purpose, not every storage_key:
--   * pre-existing pods may already hold rows sharing a legacy key (the sync
--     door upserts client-supplied keys), and a pod-wide UNIQUE would abort the
--     migration — and the pod's boot — on data this lane never wrote;
--   * keys under `/uploads/` are minted ONLY by the presigned lane, which has
--     always refused a second finalize, so no existing row can violate it.
CREATE UNIQUE INDEX IF NOT EXISTS "documents_upload_storage_key_unique"
  ON "documents" ("storage_key")
  WHERE "storage_key" LIKE 'files/%/uploads/%';
