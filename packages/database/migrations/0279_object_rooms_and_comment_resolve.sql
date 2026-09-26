-- 0279: one conversation per object (Documents v2, lane C-comments).
--
-- Founder model (2026-09-25/26): every object has ONE linked channel — its
-- "object room" — and a document comment is a message in it, anchored to a
-- block (`messages.metadata.anchor`, the D19 contract extended). Comments can
-- be resolved.
--
-- 1. `messages.resolved_at` / `resolved_by` — resolve is state on the thread's
--    ROOT message (lead default: a real column, so the open-comment count is an
--    indexed read, not a JSONB scan). Written only by the comments door.
--
-- 2. `channels_object_room_uniq` — at most ONE active object room per object.
--    The ONE mint (`ChannelRepository.ensureObjectChannel`) inserts with
--    ON CONFLICT DO NOTHING and re-selects, so two concurrent opens of the same
--    document converge on one row. The predicate MUST mirror the drizzle
--    declaration in `schema/channels.ts` and the baseline.
--
--    No row can violate it today: an object room is a GROUP channel stamped
--    `context_object_type IN ('document','entity')`, and no door before this
--    migration minted that shape (per-comment channels and per-entity recaps are
--    THREADs; external channels bound to an entity are EXTERNAL). The dedup
--    below is a guard for a pod that disagrees — oldest wins, the rest are
--    marked `merged` (the 0182 precedent), their messages stay readable.
--
-- 3. `messages_open_comment_root_idx` — the unresolved-comment count per room.
--
-- Idempotent throughout.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "resolved_by" text;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY context_object_type, context_object_id
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM channels
  WHERE channel_type = 'group'
    AND status = 'active'
    AND context_object_type IN ('document', 'entity')
    AND context_object_id IS NOT NULL
)
UPDATE channels c
SET status = 'merged', updated_at = now()
FROM ranked r
WHERE c.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "channels_object_room_uniq"
  ON "channels" ("context_object_type", "context_object_id")
  WHERE "channel_type" = 'group'
    AND "status" = 'active'
    AND "context_object_type" IN ('document', 'entity');

CREATE INDEX IF NOT EXISTS "messages_open_comment_root_idx"
  ON "messages" ("channel_id")
  WHERE "parent_id" IS NULL
    AND "resolved_at" IS NULL
    AND "deleted_at" IS NULL
    AND ("metadata" -> 'anchor') IS NOT NULL;
