-- 0329 — read_webpage intent
--
-- What a capability DOES is a row, not a TypeScript union (0283).
-- read_webpage is a READ: a verb that reads ONE web page or post (any URL)
-- into clean text, metadata and media — the pod's built-in reader ladder and
-- installed readers (a scraping actor on the person's own account) alike. The
-- intent is for DISCOVERY ("which capabilities read URLs?"); which reader
-- reads THIS url is routed by the reader's declared `urls` (skills.url_patterns,
-- 0330), never by the intent.
-- ABSTRACT_VERBS stays the seed only — this slug is a post-seed row
-- (REGISTERED_EXTRAS), exactly like publish_post (0284) and
-- delegate_agent_task (0314). The table already exists (0283, and
-- 0000_baseline_schema.sql on a fresh install); this file only inserts the row.

INSERT INTO "capability_intents" ("slug", "effect", "statement", "synonyms")
VALUES
  ('read_webpage', 'read', 'Read one web page or post (any URL) into clean text, metadata and media.',
   ARRAY['read link', 'read url', 'open url', 'open link', 'scrape', 'fetch page', 'read page', 'read this post', 'get the caption', 'read article'])
ON CONFLICT ("slug") DO NOTHING;
