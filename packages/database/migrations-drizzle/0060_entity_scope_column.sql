-- Add entity_scope column to profiles table
-- Determines whether entities of this profile type are pod-wide or workspace-scoped
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "entity_scope" text NOT NULL DEFAULT 'workspace';

-- Update existing system profiles to pod-wide where appropriate
UPDATE "profiles"
SET "entity_scope" = 'pod'
WHERE "scope" = 'system'
  AND "slug" IN ('note', 'task', 'project', 'event', 'person', 'contact', 'company', 'bookmark', 'website', 'article');
