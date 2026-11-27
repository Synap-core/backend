-- Migration: 0463_frame_drafts.sql
--
-- Who owns a draft id the frame read door answered for. A person's own
-- unsaved draft (a preview) is named by an id its host chose; the first person
-- whose read the door answered claims it here, in one insert on the primary
-- key, and anyone else naming it is refused (FRAME_DRAFT_NOT_YOURS).
--
-- Before this table the claim was read from `frame_read_log`: two first reads
-- at once could both pass, and the claim vanished when the 30-day retention
-- deleted the owner's rows. No backfill: a draft lives as long as its editor
-- is open, and its next read claims it. Idempotent.

CREATE TABLE IF NOT EXISTS "frame_drafts" (
  "draft_id"   text PRIMARY KEY,
  "user_id"    text NOT NULL,
  "claimed_at" timestamp with time zone NOT NULL DEFAULT now()
);
