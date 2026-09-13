-- 0261_entity_external_links_unique_per_connection.sql
--
-- One external link per external record PER CONNECTION, not per pod.
--
-- The old key UNIQUE (provider, external_id) allowed exactly one link row per
-- external record pod-wide. Two members syncing the same shared record (a Google
-- meeting both attend carries the same event id) collided: the second member's
-- copy could never register its own link, so it never got its own `url` and
-- could not be opened in the source app.
--
-- New key: UNIQUE (provider, external_id, nango_connection_id).
--
-- WHY A PLAIN 3-COLUMN INDEX (not partial, not COALESCE-based): an
-- `INSERT … ON CONFLICT (cols)` target must match a unique index exactly. A
-- partial or expression index would force every writer to repeat its predicate
-- or expression, which drizzle's `onConflict…({ target: [...] })` cannot express.
--
-- NULL / SENTINEL RULE (backfill, then NOT NULL): the baseline CREATE TABLE
-- declares `nango_connection_id NOT NULL`, but its defensive
-- `ADD COLUMN IF NOT EXISTS` does not, so an older pod may hold NULLs — and NULLs
-- never collide in a unique index, which would silently allow duplicates. Every
-- NULL becomes the `direct-import` sentinel the writers already use for a link
-- with no connection, then the column is pinned NOT NULL. Sentinel rows keep the
-- old behaviour (one `direct-import` link per external record). The backfill
-- cannot create a collision: the old key already allowed at most one row per
-- (provider, external_id).
--
-- ORDER: the new index is created BEFORE the old one is dropped, so the table is
-- never without a unique key. Every statement is idempotent.
--
-- DEPLOY COUPLING: a writer using `ON CONFLICT (provider, external_id)` errors
-- once the old index is gone ("no unique or exclusion constraint matching the ON
-- CONFLICT specification"). Its conflict target must move to
-- (provider, external_id, nango_connection_id) in the same release.

UPDATE "entity_external_links"
   SET "nango_connection_id" = 'direct-import'
 WHERE "nango_connection_id" IS NULL;

ALTER TABLE "entity_external_links" ALTER COLUMN "nango_connection_id" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "entity_external_links_provider_external_id_connection_idx"
  ON "entity_external_links" ("provider", "external_id", "nango_connection_id");

DROP INDEX IF EXISTS "entity_external_links_provider_external_id_idx";
