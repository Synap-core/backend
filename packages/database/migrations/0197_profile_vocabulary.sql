-- 0197_profile_vocabulary.sql
--
-- Query-understanding vocabulary made data-driven.
--
-- Adds `plural` + `synonyms` to `profiles` so the retrieval engine's
-- `understandQuery` can match a natural-language query against a profile's real
-- vocabulary (slug + display name + plural + synonyms) instead of only a
-- hardcoded 9-kind KIND_CUES list. Custom profiles ("podcast", "recipe") become
-- matchable by name; the KIND_CUES list stays as the fallback layer for pods
-- whose profiles carry no vocabulary yet.
--
-- Seeds the 9 canonical kind profiles from KIND_CUES (understand-query.ts). Each
-- UPDATE is a safe no-op on a pod that lacks the profile (WHERE slug = X matches
-- zero rows). Only WORKSPACE/USER/SYSTEM canonical slugs are targeted; the
-- values mirror the code's cue lists so behavior is identical whether the match
-- comes from the catalog (now) or the fallback (pods without these columns).

ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "plural" text;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "synonyms" text[];

-- Seed canonical vocabulary (idempotent: only fills rows that are still NULL, so
-- re-running never clobbers a user's edited vocabulary).
UPDATE "profiles" SET "plural" = 'people',
  "synonyms" = ARRAY['who','whom','person','people','contact','colleague','someone']::text[]
  WHERE "slug" = 'person' AND "plural" IS NULL;

UPDATE "profiles" SET "plural" = 'companies',
  "synonyms" = ARRAY['company','companies','org','organization','organisation','vendor','employer','firm']::text[]
  WHERE "slug" = 'company' AND "plural" IS NULL;

UPDATE "profiles" SET "plural" = 'events',
  "synonyms" = ARRAY['when','event','meeting','call','appointment','kickoff','review']::text[]
  WHERE "slug" = 'event' AND "plural" IS NULL;

UPDATE "profiles" SET "plural" = 'tasks',
  "synonyms" = ARRAY['task','todo','to-do','due','deadline','deliverable','assignment','action item']::text[]
  WHERE "slug" = 'task' AND "plural" IS NULL;

UPDATE "profiles" SET "plural" = 'decisions',
  "synonyms" = ARRAY['decide','decided','decision','chose','chosen','agreed','concluded','resolved']::text[]
  WHERE "slug" = 'decision' AND "plural" IS NULL;

UPDATE "profiles" SET "plural" = 'projects',
  "synonyms" = ARRAY['project','initiative','epic','milestone']::text[]
  WHERE "slug" = 'project' AND "plural" IS NULL;

UPDATE "profiles" SET "plural" = 'notes',
  "synonyms" = ARRAY['note','thought','idea','memo']::text[]
  WHERE "slug" = 'note' AND "plural" IS NULL;

UPDATE "profiles" SET "plural" = 'documents',
  "synonyms" = ARRAY['doc','document','report','spec','paper','memo']::text[]
  WHERE "slug" = 'document' AND "plural" IS NULL;

UPDATE "profiles" SET "plural" = 'deals',
  "synonyms" = ARRAY['deal','opportunity','pipeline']::text[]
  WHERE "slug" = 'deal' AND "plural" IS NULL;
