-- 0379 — governance_rules.revoked_reason: why a rule stopped acting
-- (structural plan S3, founder decision Q3, 29 Oct).
--
-- A grant the trust ladder earned (`source_proposal_id` set) PAUSES when two
-- receipts it decided are undone within 30 days: the soft revoke it already
-- has (`revoked_at`), plus this reason, so the rule page can say "Paused after
-- 2 undos" and the next card can offer "Ask me again". A person's own revoke
-- (`governanceRules.revoke`) leaves it NULL. No new store: one nullable column.
--
-- Idempotent.

ALTER TABLE "governance_rules" ADD COLUMN IF NOT EXISTS "revoked_reason" text;
