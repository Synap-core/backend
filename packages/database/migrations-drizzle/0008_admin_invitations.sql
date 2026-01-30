-- Migration: Admin Invitations
-- Description: Table for storing admin invitation tokens (control plane flow)
-- Allows passwordless initial admin setup via email link

CREATE TABLE IF NOT EXISTS "admin_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "backend_domain" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_admin_invitations_email" ON "admin_invitations"("email");
CREATE INDEX IF NOT EXISTS "idx_admin_invitations_token_hash" ON "admin_invitations"("token_hash");
