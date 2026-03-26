-- Migration: unified invites table
-- Replaces workspace_invites (scoped to one workspace) and pod_invites (all workspaces)
-- with a single invites table discriminated by type = 'workspace' | 'pod'.

DROP TABLE IF EXISTS "workspace_invites";
DROP TABLE IF EXISTS "pod_invites";

CREATE TABLE "invites" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type"         text NOT NULL,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "email"        text NOT NULL,
  "role"         text NOT NULL,
  "token"        text NOT NULL,
  "invited_by"   text NOT NULL,
  "expires_at"   timestamptz NOT NULL,
  "created_at"   timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "invites_token_unique" UNIQUE("token")
);
