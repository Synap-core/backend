-- 0360 — search_web intent
--
-- What a capability DOES is a row, not a TypeScript union (0283).
-- search_web is a READ: a verb that searches the public web for pages matching
-- a free-text query (Exa, a Synap-run provider, …). It is NOT search_external,
-- which means "query an outside corpus" and is declared by Notion, Dropbox,
-- Gmail and catalog searches too: `web.search` must never run one of those on
-- a caller's behalf, so the web needs its own seat. A verb declaring it takes
-- `{ query }`, the shape `web.search` hands its provider.
-- ABSTRACT_VERBS stays the seed only — this slug is a post-seed row
-- (REGISTERED_EXTRAS), like publish_post (0284), delegate_agent_task (0314) and
-- read_webpage (0329). The table already exists (0283, and
-- 0000_baseline_schema.sql on a fresh install); this file only inserts the row.

INSERT INTO "capability_intents" ("slug", "effect", "statement", "synonyms")
VALUES
  ('search_web', 'read', 'Search the public web for pages matching a query.',
   ARRAY['web search', 'search the web', 'search online', 'google it', 'look it up online', 'find pages about', 'internet search'])
ON CONFLICT ("slug") DO NOTHING;
