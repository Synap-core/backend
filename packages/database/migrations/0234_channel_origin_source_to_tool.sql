-- 0234_channel_origin_source_to_tool.sql
--
-- One-shot backfill for "capability = the lens over external data".
--
-- A channel's origin `produced` edge is written ONLY at channel birth. Before
-- this change a messaging-bridge channel was born with a bare
-- `source --produced--> channel` edge whose fromId is a PROVIDER SLUG
-- ("discord", "linkedin", …) — a slug is not a graph node, so the channel had
-- no path to its capability. `recordChannelOrigin` now upgrades a `source`
-- origin to the installed tool for that provider at birth; this migration
-- re-stamps the EXISTING (pre-change) source edges the same way, so legacy
-- channels also derive their capability via produced→tool→member_of.
--
-- Resolution mirrors the connector-registry precedence (external-dispatch.ts /
-- channel-origin.ts `pickProducerToolByScope`):
--   • match a tool by name = the slug, in the edge's workspace OR pod-wide;
--   • a workspace-scoped tool OVERRIDES a pod-wide tool of the same name;
--   • a set that is STILL ambiguous after precedence resolves to nothing — the
--     honest `source` slug is left in place rather than guessing.
-- Slugs with no installed tool (e.g. the logical feed sources "mail-feed" /
-- "event-sync", or an uninstalled provider) are left untouched.
--
-- Idempotent: after a re-stamp the edge is `from_type = 'tool'`, so it no longer
-- matches the `from_type = 'source'` filter. Runs once (tracked in _migrations)
-- and is safe to re-run.

UPDATE "links" AS l
SET
  "from_type" = 'tool',
  "from_id"   = chosen.tool_id,
  "metadata"  = jsonb_set(
    jsonb_set(
      COALESCE(l."metadata", '{}'::jsonb),
      '{producerKind}', '"tool"'::jsonb, true
    ),
    '{producerName}', to_jsonb(chosen.tool_name), true
  )
FROM (
  SELECT
    src.id AS link_id,
    -- Precedence pick: workspace-scoped rows sort before pod-wide, so [1] is the
    -- workspace tool when one exists, else the pod-wide tool.
    (ARRAY_AGG(t."id"   ORDER BY (t."workspace_id" IS NOT NULL) DESC))[1] AS tool_id,
    (ARRAY_AGG(t."name" ORDER BY (t."workspace_id" IS NOT NULL) DESC))[1] AS tool_name,
    COUNT(*) FILTER (WHERE t."workspace_id" IS NOT DISTINCT FROM src."workspace_id") AS ws_matches,
    COUNT(*) FILTER (WHERE t."workspace_id" IS NULL) AS pod_matches
  FROM "links" src
  JOIN "tools" t
    ON t."name" = src."from_id"
   AND (t."workspace_id" = src."workspace_id" OR t."workspace_id" IS NULL)
  WHERE src."link_type" = 'produced'
    AND src."from_type" = 'source'
    AND src."to_type"   = 'channel'
  GROUP BY src.id
) AS chosen
WHERE l."id" = chosen.link_id
  -- Unambiguous only: exactly one workspace match, OR zero workspace + exactly
  -- one pod-wide. Anything else is left as an honest `source` slug.
  AND (chosen.ws_matches = 1 OR (chosen.ws_matches = 0 AND chosen.pod_matches = 1))
  -- Collision guard: never create a duplicate of a `tool --produced--> channel`
  -- edge that already exists for the same channel (would violate the unique
  -- edge index). Legacy source channels never stamped a tool edge, so in
  -- practice this never trips; it keeps the UPDATE safe regardless.
  AND NOT EXISTS (
    SELECT 1 FROM "links" x
    WHERE x."from_type" = 'tool'
      AND x."from_id"   = chosen.tool_id
      AND x."to_type"   = 'channel'
      AND x."to_id"     = l."to_id"
      AND x."link_type" = 'produced'
  );
