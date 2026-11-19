-- 0435 — one approval store: a grant's exec_mode becomes an approval row
-- (the EXPAND step; the column itself is dropped by a later contract step)
-- (founder decisions D2 and D3, 19 Nov 2026, document b387ca45).
--
-- Until now two stores each answered "may this tool run without asking?": a
-- capability grant's `exec_mode` (vault_grants) and an approval row
-- (governance_rules). With a grant, its exec_mode decided and a stored
-- "ask first" row on the tool was never read. From now on an approval row is
-- the ONLY answer; a grant means only "may use" (scope, expiry, uses).
--
-- What each live capability grant (tool, skill, command; secrets are not
-- tool runs) becomes, so every agent x action decision stays the same:
--
--   exec_mode 'auto'    -> one row: the grant's agent (or anyone, when the
--                          grant names none) x this action (the grant's row
--                          id, exactly what the grant matched) x the grant's
--                          space (or the pod) -> auto, with the grant's expiry.
--                          The gate sends an auto row through the same policy
--                          rung an auto grant went through (untrusted origin,
--                          a stricter channel and the propose-only actions
--                          still ask).
--   exec_mode 'propose' -> nothing. A propose grant behaved exactly like no
--                          grant (an auto row ran it, else it asked); a
--                          propose row would now outrank broader auto rows.
--   exec_mode 'dry-run' -> one row -> propose (it never ran; now it asks).
--
-- Left out, each one stricter than before, never looser:
--   - a grant capped in uses (max_uses): an approval row has no use count,
--     so it would outlive the grant. It now asks (no door writes such a
--     grant for a tool today);
--   - an auto grant a stored "Never" (deny) could cover: as a more specific
--     auto row it could outrank that Never. It now asks unless another rule
--     says otherwise.
-- Revoked, expired and exhausted grants decide nothing today and are skipped.
--
-- `created_by` is `system:grant-exec-mode:<grant id>` (a machine author, the
-- provenance vocabulary of governance-rule-provenance.ts), which also makes a
-- second run insert nothing. `source_proposal_id` stays NULL: a row carrying
-- one is "earned" and pauses after repeated undos (the trust ladder), which a
-- grant never did. The data step runs only while the column
-- exists, so the file can run again after the column is gone.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vault_grants' AND column_name = 'exec_mode'
  ) THEN
    INSERT INTO "governance_rules" (
      "principal_kind", "agent_user_id", "scope_kind", "workspace_id",
      "target_kind", "target_pattern", "verdict", "created_by", "expires_at"
    )
    SELECT
      (CASE WHEN g."granted_to" IS NULL THEN 'any' ELSE 'agent' END)::governance_principal,
      g."granted_to",
      (CASE WHEN g."workspace_id" IS NULL THEN 'pod' ELSE 'workspace' END)::governance_scope,
      g."workspace_id",
      'capability'::governance_target,
      g."grantable_id",
      (CASE WHEN g."exec_mode"::text = 'auto' THEN 'auto' ELSE 'propose' END)::governance_verdict,
      'system:grant-exec-mode:' || g."id"::text,
      g."expires_at"
    FROM "vault_grants" g
    WHERE g."grantable_type"::text IN ('tool', 'skill', 'command')
      AND g."exec_mode"::text IN ('auto', 'dry-run')
      AND g."revoked_at" IS NULL
      AND (g."expires_at" IS NULL OR g."expires_at" > now())
      AND g."max_uses" IS NULL
      AND (
        g."exec_mode"::text <> 'auto'
        OR NOT EXISTS (
          SELECT 1 FROM "governance_rules" d
          WHERE d."verdict"::text = 'deny'
            AND d."revoked_at" IS NULL
            AND (d."expires_at" IS NULL OR d."expires_at" > now())
            AND (
              (d."target_kind"::text = 'capability'
                AND (d."target_pattern" = g."grantable_id"
                  OR d."target_pattern" IN (
                    SELECT t."name" FROM "tools" t WHERE t."id"::text = g."grantable_id"
                    UNION ALL
                    SELECT s."name" FROM "skills" s WHERE s."id"::text = g."grantable_id"
                  )))
              OR (d."target_kind"::text = 'action'
                AND d."target_pattern" IN ('*', 'capability.*', 'capability.run'))
            )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM "governance_rules" r
        WHERE r."created_by" = 'system:grant-exec-mode:' || g."id"::text
      );
  END IF;
END $$;

-- EXPAND, not contract (migrations are forward-only, check-migrations-
-- forward-only.mjs): the column stays until a release that no longer reads
-- it has shipped; its contract step (`-- synap:contract-of 0435_…`) drops it
-- and the `grant_exec_mode` type. Until then a grant written by code that no
-- longer sets it takes the default, so the default becomes 'propose': the
-- value that means "no verdict" (it behaves as no grant) if the release
-- before this one runs again after a rollback.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vault_grants' AND column_name = 'exec_mode'
  ) THEN
    ALTER TABLE "vault_grants" ALTER COLUMN "exec_mode" SET DEFAULT 'propose';
  END IF;
END $$;
