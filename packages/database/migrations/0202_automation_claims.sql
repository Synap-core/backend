CREATE TABLE IF NOT EXISTS automation_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid,
  namespace text NOT NULL,
  claim_key text NOT NULL,
  owner_run_id uuid NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS automation_claims_workspace_namespace_key_uniq
  ON automation_claims (
    COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
    namespace,
    claim_key
  );
