-- 0334_invite_acceptances
--
-- The durable trace of an accepted invite. Every accept path deletes the
-- `invites` row, so until now nothing recorded which person an invite let in,
-- or when. One row per invite (`invite_id` = the deleted invite's id), written
-- by `recordInviteAcceptance` just before the invite row goes.
--
-- Read by the application-connection "invite is the consent" rule: a person
-- who joined by invite may link their Synap account without a second owner
-- approval while the invite's OWN window (`invite_expires_at`, copied from
-- `invites.expires_at`) is open. No foreign keys: the invite row is gone by
-- design, and a removed user must not erase the record of who was let in.
--
-- Fresh installs also get the table from 0000_baseline_schema.sql; this file
-- is for pods that already booted.

CREATE TABLE IF NOT EXISTS "invite_acceptances" (
  "invite_id"         uuid PRIMARY KEY,
  "user_id"           text NOT NULL,
  "invite_type"       text NOT NULL,
  "invited_email"     text NOT NULL,
  "invited_by"        text NOT NULL,
  "invite_expires_at" timestamp with time zone NOT NULL,
  "accepted_at"       timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "invite_acceptances_user_idx"
  ON "invite_acceptances" ("user_id");
