-- 0262_focus_sessions_title.sql
--
-- A session's short optional NAME, separate from its `goal` (the outcome).
--
-- Before this, `goal` was the only text a session had, so every list showed the
-- goal verbatim — and an agent that wrote a paragraph of scope into it produced
-- a list of paragraphs. `title` is the one-line name; `goal` stays the outcome.
--
-- NULLABLE, no backfill: an untitled session displays the goal's first line,
-- clipped, through ONE resolver (`resolveSessionTitle`, @synap-core/types
-- focus-sessions). Deriving a stored title from old goals would freeze today's
-- clip rule into data.
--
-- varchar(200): bounded at the column so no door can store a paragraph here
-- either; the doors refuse longer input rather than truncating it.

ALTER TABLE "focus_sessions" ADD COLUMN IF NOT EXISTS "title" varchar(200);
