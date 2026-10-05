-- 0301 — entity relations `blocks` / `depends_on` move onto THE dependency edge.
--
-- There is ONE dependency edge in Synap: a `links` row `X --blocked_by--> Y`
-- ("X waits on Y"), across unit-of-work kinds (session · entity · track). The
-- entity relation slugs `blocks` / `depends_on` were a second copy of the same
-- fact that nothing ever read — no derived "blocked", no unblock reactor. From
-- this release the relation create doors map those two slugs onto the edge
-- (`services/links/dependency-links.ts`); this migration moves the rows that
-- were already stored.
--
-- DIRECTION (the only thing that can go wrong here, so spelled out):
--   A --blocks-->     B   ⇒   B --blocked_by--> A   (B waits on A)
--   A --depends_on--> B   ⇒   A --blocked_by--> B   (A waits on B)
--
-- WHICH ROWS: entity↔entity only (`source_kind`/`target_kind` = 'entity', both
-- ids present, not a self-edge). A cell-endpoint row is not a unit of work and
-- stays a relation.
--
-- PROVENANCE: the edge carries what the relation knew, in `links.metadata`
-- (`relationType`, `migratedFromRelationId`, `createdByKind`, `agentUserId`,
-- `sourceProposalId`, `correlationId`; nulls dropped). `created_by` = the
-- author (`created_by_user_id`, else the owner). `workspace_id` = the BLOCKED
-- end's own workspace — the same stamp the door writes — else the relation's.
--
-- DUPLICATES: the unique edge index makes a re-run, or two relations naming the
-- same dependency (`A blocks B` and `B depends_on A`), land ONE edge.
--
-- THE RELATION ROWS ARE DELETED, not marked: nothing reads `blocks` /
-- `depends_on` relations by type (verified 2026-10-05 — the only typed readers
-- were the node-neighbourhood role table, which now reads the links edge), and
-- keeping them would draw every dependency twice. Only rows whose edge now
-- EXISTS are deleted, so a row the insert could not move is never lost.
--
-- Idempotent: a second run inserts nothing (conflict) and deletes nothing
-- (already gone).

WITH moved AS (
  SELECT
    r.id,
    r.type,
    r.workspace_id,
    r.user_id,
    r.created_by_user_id,
    r.created_by_kind,
    r.agent_user_id,
    r.source_proposal_id,
    r.correlation_id,
    r.created_at,
    CASE WHEN r.type = 'blocks' THEN r.target_entity_id ELSE r.source_entity_id END AS blocked_id,
    CASE WHEN r.type = 'blocks' THEN r.source_entity_id ELSE r.target_entity_id END AS blocker_id
  FROM relations r
  WHERE r.type IN ('blocks', 'depends_on')
    AND COALESCE(r.source_kind, 'entity') = 'entity'
    AND COALESCE(r.target_kind, 'entity') = 'entity'
    AND r.source_entity_id IS NOT NULL
    AND r.target_entity_id IS NOT NULL
    AND r.source_entity_id <> r.target_entity_id
)
INSERT INTO links (
  workspace_id, from_type, from_id, to_type, to_id, link_type,
  metadata, created_by, created_at
)
SELECT
  COALESCE(e.workspace_id, m.workspace_id),
  'entity', m.blocked_id::text,
  'entity', m.blocker_id::text,
  'blocked_by',
  jsonb_strip_nulls(jsonb_build_object(
    'relationType', m.type,
    'migratedFromRelationId', m.id::text,
    'createdByKind', m.created_by_kind,
    'agentUserId', m.agent_user_id,
    'sourceProposalId', m.source_proposal_id::text,
    'correlationId', m.correlation_id::text
  )),
  COALESCE(m.created_by_user_id, m.user_id),
  m.created_at
FROM moved m
LEFT JOIN entities e ON e.id = m.blocked_id
ORDER BY m.created_at ASC
ON CONFLICT (from_type, from_id, to_type, to_id, link_type) DO NOTHING;

DELETE FROM relations r
USING links l
WHERE r.type IN ('blocks', 'depends_on')
  AND COALESCE(r.source_kind, 'entity') = 'entity'
  AND COALESCE(r.target_kind, 'entity') = 'entity'
  AND r.source_entity_id IS NOT NULL
  AND r.target_entity_id IS NOT NULL
  AND l.link_type = 'blocked_by'
  AND l.from_type = 'entity'
  AND l.to_type = 'entity'
  AND l.from_id = (CASE WHEN r.type = 'blocks' THEN r.target_entity_id ELSE r.source_entity_id END)::text
  AND l.to_id   = (CASE WHEN r.type = 'blocks' THEN r.source_entity_id ELSE r.target_entity_id END)::text;
