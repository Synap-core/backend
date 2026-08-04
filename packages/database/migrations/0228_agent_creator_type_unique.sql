-- Migration: 0228_agent_creator_type_unique.sql
--
-- Product invariant: one surface/service agent user per (createdByUserId, agentType).
-- Replaces 0037's pod-wide unique on agentType alone (which forced all humans on a
-- team pod to share one claude-code principal — wrong for scorecards/caps/audit).
--
-- Twin / personal agent indexes from 0037 stay unchanged.
-- User-custom templates (assistant/custom) stay unconstrained.
--
-- Steps:
--   1. Backfill created_by_user_id + agent_type + agent_metadata from keys/metadata
--   2. Drop old service-agent type-only unique index
--   3. Add unique (created_by_user_id, agent_type) for service agents with non-null creator

-- ── 1a. Prefer column agent_type from metadata when column empty ─────────────
UPDATE users
SET agent_type = COALESCE(agent_type, agent_metadata->>'agentType')
WHERE user_type = 'agent'
  AND agent_type IS NULL
  AND agent_metadata->>'agentType' IS NOT NULL;

-- ── 1b. Backfill created_by_user_id: metadata → oldest hub key linkedUserId ─
UPDATE users u
SET created_by_user_id = COALESCE(
  u.created_by_user_id,
  NULLIF(u.agent_metadata->>'createdByUserId', ''),
  (
    SELECT k.linked_user_id
    FROM api_keys k
    WHERE k.user_id = u.id
      AND k.linked_user_id IS NOT NULL
    ORDER BY k.created_at ASC NULLS LAST
    LIMIT 1
  )
)
WHERE u.user_type = 'agent'
  AND u.created_by_user_id IS NULL;

-- ── 1c. Dual-write metadata.createdByUserId for readers still on JSONB ───────
UPDATE users
SET agent_metadata = COALESCE(agent_metadata, '{}'::jsonb)
  || jsonb_build_object('createdByUserId', created_by_user_id)
  || CASE
       WHEN agent_type IS NOT NULL
         THEN jsonb_build_object('agentType', agent_type)
       ELSE '{}'::jsonb
     END
WHERE user_type = 'agent'
  AND created_by_user_id IS NOT NULL
  AND (
    agent_metadata->>'createdByUserId' IS DISTINCT FROM created_by_user_id
    OR agent_metadata->>'agentType' IS DISTINCT FROM agent_type
  );

-- ── 1d. Soft-heal: if multiple service agents share (creator, type), keep oldest
--     (rare under old pod-wide singleton). Retire newer rows by suffixing
--     agent_type so the unique index can apply; humans re-connect for a clean principal.
WITH ranked AS (
  SELECT
    id,
    agent_type,
    ROW_NUMBER() OVER (
      PARTITION BY created_by_user_id, agent_type
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM users
  WHERE user_type = 'agent'
    AND COALESCE(is_personal_agent, false) = false
    AND (agent_template IS NULL)
    AND created_by_user_id IS NOT NULL
    AND agent_type IS NOT NULL
)
UPDATE users u
SET
  agent_type = r.agent_type || '-dup-' || LEFT(u.id, 8),
  agent_metadata = COALESCE(u.agent_metadata, '{}'::jsonb)
    || jsonb_build_object(
      'agentType', r.agent_type || '-dup-' || LEFT(u.id, 8),
      'retiredAsDuplicate', true
    )
FROM ranked r
WHERE u.id = r.id
  AND r.rn > 1;

-- ── 2. Drop pod-wide service agent type unique (0037) ───────────────────────
DROP INDEX IF EXISTS idx_users_service_agent_type_unique;

-- ── 3. One service agent per (creator, type) ────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_service_agent_creator_type_unique
  ON users (created_by_user_id, agent_type)
  WHERE user_type = 'agent'
    AND agent_template IS NULL
    AND COALESCE(is_personal_agent, false) = false
    AND created_by_user_id IS NOT NULL
    AND agent_type IS NOT NULL;
