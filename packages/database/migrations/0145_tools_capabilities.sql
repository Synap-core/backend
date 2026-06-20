-- 0145 — Structured verb catalog on `tools` (the capability-matrix axis).
--
-- Adds `tools.capabilities` jsonb: a connector's VERBS as structured, enumerable
-- data — `[{ id, label, kind: "read"|"write"|"action", argsSchema?, govDefault:
-- "auto"|"propose"|"dry-run" }]`. `id` is stable (the requiring skill's name);
-- `kind` maps onto the read(pull)/write|action(push) capability-matrix axis;
-- `govDefault` aligns to the exec-mode the seeded `vault_grants` row carries, so a
-- verb never bypasses the approved + grant governance model.
--
-- The catalog is DERIVED from each tool's `CapabilityDefinition` (the skills that
-- `requires` the tool) at apply time, never hand-authored. Existing tools keep an
-- empty `[]` until their family template is (re-)applied. Defensive/idempotent per
-- backend-rules (ADD COLUMN IF NOT EXISTS).

ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "capabilities" jsonb NOT NULL DEFAULT '[]'::jsonb;
