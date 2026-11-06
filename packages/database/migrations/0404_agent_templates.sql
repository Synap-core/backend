-- 0404 — Agent templates, installed by the catalog (founder decisions D8-D10,
-- proposal 3649da4d; plan v2, pod document 66d229dc §2.3).
--
-- `agent_templates`: ONE row per AI program the pod knows (Claude Code, Codex,
-- Hermes…), installed pod-wide from the catalog kind `agent`. Its fields are
-- the catalog's `definition.agent`, one column each so a template update is a
-- per-field keep/drop diff (`metadata.marketSource.baseline`, the source link
-- every standalone installed kind carries). `slug` is the catalog package
-- slug; `harness` is the `users.agent_type` of its agents.
--
-- `users.agent_template_slug`: the agent's link to its template (by slug, no
-- FK: an agent can exist before its template is installed). NOT
-- `agent_template`, which already means twin / assistant / custom.
--
-- Re-runnable: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "agent_templates" (
  "id"           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"         text    NOT NULL,
  "name"         text    NOT NULL,
  "harness"      text    NOT NULL,
  "aliases"      jsonb   NOT NULL DEFAULT '[]',
  "worker"       boolean NOT NULL DEFAULT false,
  "tried"        boolean NOT NULL DEFAULT false,
  "detect"       jsonb,
  "wake"         jsonb,
  "practices"    jsonb   NOT NULL DEFAULT '{"skills":[]}',
  "metadata"     jsonb   NOT NULL DEFAULT '{}',
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"   timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_templates_slug_unique"
  ON "agent_templates" ("slug");
CREATE INDEX IF NOT EXISTS "agent_templates_harness_idx"
  ON "agent_templates" ("harness");

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "agent_template_slug" text;
CREATE INDEX IF NOT EXISTS "idx_users_agent_template_slug"
  ON "users" ("agent_template_slug")
  WHERE "agent_template_slug" IS NOT NULL;
