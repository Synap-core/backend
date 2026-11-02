-- 0393 — a channel is the conversation with a person (channels wave, lane A,
-- pod session 61cd1744, design d00cd2ac §1).
--
-- messages gain three columns:
--   direction            'inbound' | 'outbound'; NULL = in-pod chat
--   delivery_status      'sent' | 'delivered' | 'read' | 'failed'; never
--                        'proposed' (a proposed message is the
--                        `messaging.external.send` PROPOSAL, not a row here)
--   external_message_id  the provider's message id (was only in
--                        metadata->>'externalMessageId')
--
-- Indexes:
--   messages_channel_ext_msg_uniq   one row per provider message per channel:
--                                   the echo of a message the pod sent and
--                                   the webhook copy of it collapse to one.
--   channels_external_pending_uniq  one PENDING channel (no provider chat id
--                                   yet) per person, tool and account: a
--                                   lead's channel exists from the first draft.
--   proposals_msg_channel_idx       the pending proposed messages of a channel
--                                   (data->>'channelId').
--
-- Backfill (idempotent, no deletes):
--   · external_message_id ← metadata->>'externalMessageId'; when two rows of a
--     channel carry the same id, the OLDEST keeps it (the others stay as they
--     are, their metadata untouched).
--   · in EXTERNAL channels: author_type 'external' → inbound; every other row
--     → outbound, delivery_status 'sent'.
--   · a second PENDING external channel for the same person, tool and account
--     (it would block the unique index) is ARCHIVED, the oldest kept; its
--     messages stay. metadata.archivedBy = '0393' says why.
--
-- Fresh installs get the columns and indexes from 0000_baseline_schema.sql.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "direction" text;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "delivery_status" text;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "external_message_id" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_direction_check'
  ) THEN
    ALTER TABLE "messages"
      ADD CONSTRAINT "messages_direction_check"
      CHECK ("direction" IS NULL OR "direction" IN ('inbound', 'outbound'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_delivery_status_check'
  ) THEN
    ALTER TABLE "messages"
      ADD CONSTRAINT "messages_delivery_status_check"
      CHECK ("delivery_status" IS NULL
        OR "delivery_status" IN ('sent', 'delivered', 'read', 'failed'));
  END IF;
END $$;

-- ── Backfill: the provider message id, oldest row first ────────────────────
WITH candidates AS (
  SELECT m."id",
         m."channel_id",
         m."metadata" ->> 'externalMessageId' AS ext,
         row_number() OVER (
           PARTITION BY m."channel_id", m."metadata" ->> 'externalMessageId'
           ORDER BY m."timestamp", m."id"
         ) AS rn
    FROM "messages" m
   WHERE m."external_message_id" IS NULL
     AND COALESCE(m."metadata" ->> 'externalMessageId', '') <> ''
)
UPDATE "messages" t
   SET "external_message_id" = c.ext
  FROM candidates c
 WHERE t."id" = c."id"
   AND c.rn = 1
   AND NOT EXISTS (
     SELECT 1 FROM "messages" o
      WHERE o."channel_id" = c."channel_id"
        AND o."external_message_id" = c.ext
   );

-- ── Backfill: direction in external channels ───────────────────────────────
UPDATE "messages" m
   SET "direction" = 'inbound'
  FROM "channels" ch
 WHERE ch."id" = m."channel_id"
   AND ch."channel_type" = 'external'
   AND m."direction" IS NULL
   AND m."author_type" = 'external';

UPDATE "messages" m
   SET "direction" = 'outbound',
       "delivery_status" = COALESCE(m."delivery_status", 'sent')
  FROM "channels" ch
 WHERE ch."id" = m."channel_id"
   AND ch."channel_type" = 'external'
   AND m."direction" IS NULL
   AND m."author_type" <> 'external';

-- ── One pending channel per person, tool and account ───────────────────────
WITH ranked AS (
  SELECT c."id",
         row_number() OVER (
           PARTITION BY c."user_id", c."external_source", c."context_object_id",
                        COALESCE(c."metadata" ->> 'accountId', '')
           ORDER BY c."created_at", c."id"
         ) AS rn
    FROM "channels" c
   WHERE c."channel_type" = 'external'
     AND c."external_id" IS NULL
     AND c."status" = 'active'
     AND c."external_source" IS NOT NULL
     AND c."context_object_id" IS NOT NULL
)
UPDATE "channels" c
   SET "status" = 'archived',
       "metadata" = COALESCE(c."metadata", '{}'::jsonb)
                    || jsonb_build_object('archivedBy', '0393'),
       "updated_at" = now()
  FROM ranked r
 WHERE c."id" = r."id"
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "messages_channel_ext_msg_uniq"
  ON "messages" ("channel_id", "external_message_id")
  WHERE "external_message_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "channels_external_pending_uniq"
  ON "channels" ("user_id", "external_source", "context_object_id",
                 (COALESCE("metadata" ->> 'accountId', '')))
  WHERE "channel_type" = 'external'
    AND "external_id" IS NULL
    AND "status" = 'active';

CREATE INDEX IF NOT EXISTS "proposals_msg_channel_idx"
  ON "proposals" (("data" ->> 'channelId'))
  WHERE "proposal_type" = 'messaging.external.send'
    AND "status" = 'pending';
