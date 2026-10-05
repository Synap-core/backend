-- 0299: renderer_bindings.surface — WHICH HOST renders a binding.
--
-- Until now a binding answered one question: which renderer the IN-APP
-- surface (browser + relay) uses for a subject. Outside agent hosts (Claude,
-- ChatGPT) now render Synap UI inline via MCP Apps, and which installed
-- `rendererType: "mcp-app"` cell answers for them is chosen through this SAME
-- table, on a second surface.
--
--   'app'     — the in-app renderer. Every existing row, and the default.
--   'mcp-app' — an outside MCP-Apps host.
--
-- `surface` joins the active-unique key so an in-app and an MCP-App binding
-- for the same (scope, owner, subject, content kind) can coexist. The index is
-- dropped and recreated rather than altered (Postgres cannot add a column to an
-- index in place); every existing row is 'app', so the new key cannot collide
-- where the old one did not.
--
-- Kept `text`, not an enum, for the reason `content_kind` is: a new surface is
-- a code change, not a migration. Idempotent.

ALTER TABLE "renderer_bindings"
  ADD COLUMN IF NOT EXISTS "surface" text NOT NULL DEFAULT 'app';

DROP INDEX IF EXISTS "renderer_bindings_active_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "renderer_bindings_active_unique"
  ON "renderer_bindings" (
    "scope_kind",
    coalesce("user_id", ''),
    coalesce("workspace_id"::text, ''),
    "subject_kind",
    coalesce("subject_id", ''),
    "content_kind",
    "surface"
  )
  WHERE "revoked_at" IS NULL;
