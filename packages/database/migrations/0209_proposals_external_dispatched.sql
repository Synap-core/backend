-- Migration: 0209_proposals_external_dispatched.sql
--
-- Executor-safety E2: at-most-once claim for irreversible external sends.
--
-- The four external proposal executors (messaging.external.send, provider.action,
-- capability.run, capability/run) fire an irreversible external call BEFORE the
-- proposal status flips to APPROVED. A Retry re-ran the executor and re-fired the
-- external call → double-send. This column is an atomic dispatch claim: each
-- executor does `UPDATE proposals SET external_dispatched_at = now() WHERE id = ?
-- AND external_dispatched_at IS NULL RETURNING id` BEFORE the external call. A
-- returned row means we won the claim and must fire exactly once; no row means a
-- prior attempt already dispatched, so the executor skips the external call and
-- just closes the proposal. The claim is never un-stamped — a rare lost send on
-- crash is the accepted tradeoff over a double-send.
--
-- Additive, idempotent. Also added to 0000_baseline_schema.sql + schema-coherence.ts.

ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "external_dispatched_at" timestamptz;
