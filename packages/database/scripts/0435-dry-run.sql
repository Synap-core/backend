-- 0435 DRY RUN — READ ONLY. What migration 0435 (a grant's exec_mode becomes
-- an approval row, decisions D2/D3, document b387ca45) would do on THIS pod,
-- and which agent × action decisions it would change. Run it BEFORE 0435,
-- inside a read-only transaction:
--
--   BEGIN TRANSACTION READ ONLY;
--   \i packages/database/scripts/0435-dry-run.sql
--   ROLLBACK;
--
-- One result set: (section, item, n). Sections:
--   1-grants        live and total grants, by kind and exec_mode
--   2-outcome       what 0435 does with each live tool/skill/command grant
--   3-row           each row 0435 would write (n = 1 per row)
--   4-change-*      decisions that change, each a named, explained class:
--     ask-first     an auto grant whose agent × action is covered by a stored
--                   "ask first" row of equal or higher rank: it RAN (the row
--                   was never read), it now ASKS (D2's intended fix)
--     ambiguous     an auto and a propose grant both live for one redeemer
--                   on one action, uncapped and with no expiry (typically a
--                   session pre-approval beside the install's seeded grant):
--                   they DISAGREE and the grant lookup's ORDER BY tied, so
--                   which one decided was arbitrary (ran or asked). After
--                   0435 the AUTO one wins: it RUNS (its auto row; the
--                   propose grant makes no row). One line per pair, with
--                   the agent and the space it concerns
--     never         an auto grant a "Never" could cover is not carried over:
--                   for an agent the Never does not reach it RAN, it now ASKS
--     capped        a live auto grant capped in uses: it RAN until used up,
--                   it now ASKS
--     dry-run       a dry-run grant: it PREVIEWED, it now ASKS
--     tie           an active auto row and an "ask first" row of the same
--                   reach (principal, scope, action): the newer won, now the
--                   stricter wins; listed when the auto row was the newer
--     tool-row      an active row naming a tool CONTAINER id: before, it
--                   matched nothing; it now covers each member action
--     channel-*     NOT A CHANGE (kept as before, W1 lead's default; the
--                   founder decides at review): an auto approval row does NOT
--                   meet the channel rung (policy rung 7: an agent member with
--                   can_act = false makes a run propose), as an auto rule never
--                   did. Counted for that decision: channel-rows = active auto
--                   capability rows the rung would reach; channel-members =
--                   agent memberships with can_act = false. No caller of
--                   gateCapabilityExecution passes channelCapabilities today
--                   (verified at backend 684311a5)
--
-- Matching mirrors 0435 and `resolveGovernanceRule`: a grant matches a
-- redeemer when granted_to / workspace_id is NULL or equal; a row's reach is
-- principal (agent 2, class 1, any 0) + scope (workspace 2, pod 0) + target
-- (the action 3, its tool 2).

WITH live AS (
  SELECT g.*,
    COALESCE(
      (SELECT t."name" FROM "tools" t WHERE t."id"::text = g."grantable_id"),
      (SELECT s."name" FROM "skills" s WHERE s."id"::text = g."grantable_id")
    ) AS verb_name
  FROM "vault_grants" g
  WHERE g."grantable_type"::text IN ('tool', 'skill', 'command')
    AND g."revoked_at" IS NULL
    AND (g."expires_at" IS NULL OR g."expires_at" > now())
    AND (g."max_uses" IS NULL OR g."use_count" < g."max_uses")
),
active_rules AS (
  SELECT r.* FROM "governance_rules" r
  WHERE r."revoked_at" IS NULL
    AND (r."expires_at" IS NULL OR r."expires_at" > now())
    AND r."target_kind"::text = 'capability'
    AND r."target_subject_id" IS NULL
),
cls AS (
  SELECT l.*,
    EXISTS (
      SELECT 1 FROM "governance_rules" d
      WHERE d."verdict"::text = 'deny'
        AND d."revoked_at" IS NULL
        AND (d."expires_at" IS NULL OR d."expires_at" > now())
        AND (
          (d."target_kind"::text = 'capability'
            AND (d."target_pattern" = l."grantable_id" OR d."target_pattern" = l.verb_name))
          OR (d."target_kind"::text = 'action'
            AND d."target_pattern" IN ('*', 'capability.*', 'capability.run'))
        )
    ) AS never_could_cover,
    (CASE WHEN l."granted_to" IS NULL THEN 0 ELSE 2 END)
      + (CASE WHEN l."workspace_id" IS NULL THEN 0 ELSE 2 END) + 3 AS row_score
  FROM live l
),
outcome AS (
  SELECT c.*,
    CASE
      WHEN c."exec_mode"::text = 'propose' THEN 'no row: a propose grant behaved as no grant'
      WHEN c."max_uses" IS NOT NULL THEN 'none: capped in uses'
      WHEN c."exec_mode"::text = 'dry-run' THEN 'row: ask first (was dry-run)'
      WHEN c.never_could_cover THEN 'none: a Never could cover it'
      ELSE 'row: auto'
    END AS what
  FROM cls c
)
SELECT '1-grants' AS section,
       g."grantable_type"::text || ' ' || g."exec_mode"::text
         || CASE WHEN g."revoked_at" IS NULL
                  AND (g."expires_at" IS NULL OR g."expires_at" > now())
                  AND (g."max_uses" IS NULL OR g."use_count" < g."max_uses")
                 THEN ' live' ELSE ' not live' END AS item,
       count(*)::int AS n
  FROM "vault_grants" g
 GROUP BY 1, 2
UNION ALL
SELECT '2-outcome', o.what || ' (' || o."grantable_type"::text || ')', count(*)::int
  FROM outcome o GROUP BY 1, 2
UNION ALL
SELECT '3-row',
       o."id"::text || ' ' || o."grantable_type"::text || ' '
         || coalesce(o.verb_name, o."grantable_id")
         || ' agent=' || coalesce(o."granted_to", 'anyone')
         || ' space=' || coalesce(o."workspace_id"::text, 'pod')
         || ' -> ' || CASE WHEN o."exec_mode"::text = 'auto' THEN 'auto' ELSE 'propose' END,
       1
  FROM outcome o WHERE o.what LIKE 'row:%'
UNION ALL
SELECT '4-change-ask-first',
       o."id"::text || ' ' || coalesce(o.verb_name, o."grantable_id")
         || ' agent=' || coalesce(o."granted_to", 'anyone')
         || ' space=' || coalesce(o."workspace_id"::text, 'pod'),
       1
  FROM outcome o
 WHERE o.what = 'row: auto'
   AND EXISTS (
     SELECT 1 FROM active_rules p
     WHERE p."verdict"::text = 'propose'
       AND (p."target_pattern" = o."grantable_id" OR p."target_pattern" = o.verb_name)
       AND (p."principal_kind"::text IN ('any', 'class')
            OR (p."principal_kind"::text = 'agent'
                AND (o."granted_to" IS NULL OR p."agent_user_id" = o."granted_to")))
       AND (p."scope_kind"::text = 'pod'
            OR o."workspace_id" IS NULL
            OR p."workspace_id" = o."workspace_id")
       AND (CASE p."principal_kind"::text WHEN 'agent' THEN 2 WHEN 'class' THEN 1 ELSE 0 END)
           + (CASE WHEN p."scope_kind"::text = 'workspace' THEN 2 ELSE 0 END) + 3
           >= o.row_score
   )
UNION ALL
SELECT '4-change-ambiguous',
       a."id"::text || ' (auto) and ' || p."id"::text || ' (propose) on '
         || coalesce(a.verb_name, a."grantable_id")
         || ' agent=' || coalesce(a."granted_to", p."granted_to", 'anyone')
         || ' space=' || coalesce(a."workspace_id"::text, p."workspace_id"::text, 'pod')
         || ' -> after 0435: auto (runs)',
       1
  FROM live a JOIN live p
    ON p."grantable_type" = a."grantable_type"
   AND p."grantable_id" = a."grantable_id"
   AND a."exec_mode"::text = 'auto' AND p."exec_mode"::text = 'propose'
   AND a."max_uses" IS NULL AND p."max_uses" IS NULL
   AND a."expires_at" IS NULL AND p."expires_at" IS NULL
   AND (a."granted_to" IS NULL OR p."granted_to" IS NULL OR a."granted_to" = p."granted_to")
   AND (a."workspace_id" IS NULL OR p."workspace_id" IS NULL OR a."workspace_id" = p."workspace_id")
UNION ALL
SELECT '4-change-never', o."id"::text || ' ' || coalesce(o.verb_name, o."grantable_id"), 1
  FROM outcome o WHERE o.what = 'none: a Never could cover it'
UNION ALL
SELECT '4-change-capped', o."id"::text || ' ' || coalesce(o.verb_name, o."grantable_id"), 1
  FROM outcome o WHERE o.what = 'none: capped in uses' AND o."exec_mode"::text = 'auto'
UNION ALL
SELECT '4-change-dry-run', o."id"::text || ' ' || coalesce(o.verb_name, o."grantable_id"), 1
  FROM outcome o WHERE o.what = 'row: ask first (was dry-run)'
UNION ALL
SELECT '4-change-tie',
       a."id"::text || ' (auto, newer) vs ' || p."id"::text || ' (ask first) on ' || a."target_pattern",
       1
  FROM active_rules a JOIN active_rules p
    ON a."verdict"::text = 'auto' AND p."verdict"::text = 'propose'
   AND a."target_pattern" = p."target_pattern"
   AND a."principal_kind" = p."principal_kind"
   AND a."agent_user_id" IS NOT DISTINCT FROM p."agent_user_id"
   AND a."principal_class" IS NOT DISTINCT FROM p."principal_class"
   AND a."scope_kind" = p."scope_kind"
   AND a."workspace_id" IS NOT DISTINCT FROM p."workspace_id"
   AND a."created_at" > p."created_at"
UNION ALL
SELECT '4-change-tool-row',
       r."id"::text || ' ' || r."verdict"::text || ' names tool ' || c."name",
       1
  FROM active_rules r JOIN "capabilities" c ON c."id"::text = r."target_pattern"
UNION ALL
SELECT '4-change-channel-rows',
       'active auto capability rows the channel rung would reach (not applied)',
       count(*)::int
  FROM active_rules WHERE "verdict"::text = 'auto'
UNION ALL
SELECT '4-change-channel-members',
       'agent channel memberships with can_act = false, in '
         || count(DISTINCT m."channel_id")::text || ' channel(s) (rung not applied)',
       count(*)::int
  FROM "channel_members" m
 WHERE m."member_kind" = 'ai_agent' AND m."can_act" = false
ORDER BY 1, 2;
