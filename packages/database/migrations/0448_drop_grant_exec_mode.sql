-- 0448 — the CONTRACT step of 0435: drop vault_grants.exec_mode and its type
-- synap:contract-of 0435_grant_exec_mode_to_approval_rows.sql
--
-- 0435 (backend#1188, decisions D2 and D3, document b387ca45) moved every
-- grant's exec_mode verdict into an approval row (`governance_rules`), and
-- since #1188 no code reads or writes the column: the capability gate reads
-- approval rows only, and a grant means "may use". The column was kept,
-- defaulting to 'propose' (the value that decides nothing), so the release
-- before #1188 could run again after a rollback. Once a release carrying
-- 0435 has shipped, nothing that may run again reads the column, and this
-- step drops it.
--
-- Order on a pod updating across both: 0435 runs first (it moves the
-- verdicts while the column exists), then this. Idempotent: IF EXISTS on both.

ALTER TABLE "vault_grants" DROP COLUMN IF EXISTS "exec_mode";
DROP TYPE IF EXISTS grant_exec_mode;
