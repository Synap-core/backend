-- 0232_proposals_reason_code.sql
--
-- Hybrid rejection cause: keep the free-text `rejection_reason` AND add a
-- structured, app-level reason CODE alongside it (the calibration wave's
-- "why was this rejected" taxonomy).
--
-- DELIBERATELY NOT a DB enum: the vocabulary is an app-level const
-- (`PROPOSAL_REJECTION_REASONS` in @synap/types — the SSOT both the pod and the
-- DenyProposalModal import), so the set can extend without a migration and a
-- free-text fallback (`other` + `rejection_reason`) always remains possible.
-- Nullable — every existing proposal and every reject that omits a code stays
-- NULL, so this is fully additive + back-compat.

ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "reason_code" text;
