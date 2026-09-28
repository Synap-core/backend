-- 0290 — at most ONE pod-wide notification_preferences row per person.
--
-- The pod-wide row (workspace_id IS NULL) holds the person's push categories
-- (0289) and is written by select-then-insert doors; two concurrent first
-- writes could each insert one, and every reader's `findFirst` then picked an
-- arbitrary one. The partial unique index makes the row unique, and the push
-- prefs door upserts on it (ON CONFLICT (user_id) WHERE workspace_id IS NULL).
--
-- Duplicates first: keep the most recently UPDATED pod-wide row per person
-- (the one their last save touched; ties broken by id) and delete the rest.
-- Their settings are lost, deliberately: readers never had a defined winner.
DELETE FROM "notification_preferences" p
 USING "notification_preferences" q
 WHERE p."workspace_id" IS NULL
   AND q."workspace_id" IS NULL
   AND p."user_id" = q."user_id"
   AND (p."updated_at", p."id") < (q."updated_at", q."id");

CREATE UNIQUE INDEX IF NOT EXISTS "notif_prefs_user_pod_unique"
  ON "notification_preferences" ("user_id")
  WHERE "workspace_id" IS NULL;
