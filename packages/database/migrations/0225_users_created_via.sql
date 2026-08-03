-- 0225_users_created_via.sql
-- Agent provenance: how an agent-user came to exist ('cli' | 'intelligence-service'
-- | 'ui' | 'system'). Null for humans and for agents created before this migration.
-- Read by the Agent dashboard; stamped at each agent-user creation call-site.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "created_via" text;
