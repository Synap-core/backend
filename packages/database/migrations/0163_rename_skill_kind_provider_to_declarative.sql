-- 0163_rename_skill_kind_provider_to_declarative.sql
--
-- Rename the skill EXECUTION kind 'provider' -> 'declarative'.
--
-- WHY: 'provider' was overloaded — tools.kind='provider' means "a connector
-- integration" (the credential-owning connector), while skills.kind='provider'
-- meant "a declarative in-process verb spec". Same word, two objects. The verb
-- discriminator is now 'declarative' so 'provider' unambiguously means the
-- connector. The execution path (executeProviderVerb + providerSpec column) is
-- UNCHANGED — only the discriminator VALUE moves.
--
-- skills.kind is a plain text column (no DB CHECK — the enum is enforced at the
-- Drizzle type layer), so this is a pure data rename. Idempotent and safe: on
-- pods with no 'provider'-kind skills it updates zero rows.

UPDATE "skills" SET "kind" = 'declarative' WHERE "kind" = 'provider';
