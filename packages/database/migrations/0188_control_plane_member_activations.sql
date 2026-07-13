-- Managed Control Plane member projection. The Pod remains independent for
-- local users; these nullable/mapping records apply only to CP-orchestrated
-- invitations and make activation retries safe.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "control_plane_user_id" text;

CREATE UNIQUE INDEX IF NOT EXISTS "users_control_plane_user_id_unique"
  ON "users" ("control_plane_user_id")
  WHERE "control_plane_user_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "control_plane_member_activations" (
  "activation_id" text PRIMARY KEY,
  "control_plane_user_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "role" text NOT NULL CHECK ("role" IN ('admin', 'editor', 'viewer')),
  "activated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "control_plane_member_activations_user_workspace_idx"
  ON "control_plane_member_activations" ("user_id", "workspace_id");
