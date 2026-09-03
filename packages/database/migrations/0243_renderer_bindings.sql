-- 0243_renderer_bindings.sql
--
-- renderer_bindings — the ONE store for "which renderer answers for this
-- subject", replacing the three legacy stores it is layered ABOVE:
--   `workspaces.settings.profileRenderers`, `profiles.default_renderers`
--   (+ the deprecated `default_*_renderer` columns).
--
-- Additive and INERT on arrival: this wave lands the table + the read rung
-- ONLY. There is no writer yet, so the table is empty on every pod and
-- `getEffectiveRendererWithSource` resolves BYTE-IDENTICALLY to today (the
-- new rungs all miss, and the legacy chain answers unchanged). The write
-- doors land in a later wave.
--
-- Shape mirrors `governance_rules` (0215) and `config_settings` (0235): a small
-- scoped-row table a specificity-ranking resolver reads, with a `revoked_at`
-- tombstone rather than a DELETE, and `source_proposal_id` lineage for a row a
-- proposal approval minted.
--
-- The scope LADDER (most specific first), applied by the resolver:
--   user·object → user·kind → workspace·object → workspace·kind
--   → pod·object → pod·kind
-- `subject_id IS NULL` means "the whole KIND"; a non-null `subject_id` pins one
-- object. `subject_kind` for an entity is the PROFILE SLUG (so an existing
-- caller passes exactly the key it already passes); every non-entity subject
-- uses its object-nav kind string (`capability`, `session`, `automation`, …).

DO $$ BEGIN
  CREATE TYPE renderer_binding_scope AS ENUM ('user', 'workspace', 'pod');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "renderer_bindings" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  "scope_kind"          renderer_binding_scope NOT NULL,
  -- Set when scope_kind = 'user' (enforced by the CHECK below).
  "user_id"             text,
  -- Set when scope_kind = 'workspace'. Cascades: a deleted workspace's
  -- bindings are meaningless, never orphaned rows a resolver could still read.
  "workspace_id"        uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,

  -- Entity subjects: the profile slug. Everything else: the object-nav kind.
  "subject_kind"        text NOT NULL,
  -- NULL = the whole kind; a value pins one object.
  "subject_id"          text,
  -- ProfileRendererContentKind: entity-detail | entity-card | entity-profile
  -- | collection. Kept `text`, not an enum, so a new content kind is a code
  -- change and not a migration.
  "content_kind"        text NOT NULL,

  -- The RendererRef itself (cell | view | declarative | …).
  "ref"                 jsonb NOT NULL,

  "source_proposal_id"  uuid,

  "created_by"          text NOT NULL,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "revoked_at"          timestamptz
);

-- Idempotent guard for a pre-existing table (mirrors repo convention).
ALTER TABLE "renderer_bindings" ADD COLUMN IF NOT EXISTS "scope_kind" renderer_binding_scope;
ALTER TABLE "renderer_bindings" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "renderer_bindings" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "renderer_bindings" ADD COLUMN IF NOT EXISTS "subject_kind" text;
ALTER TABLE "renderer_bindings" ADD COLUMN IF NOT EXISTS "subject_id" text;
ALTER TABLE "renderer_bindings" ADD COLUMN IF NOT EXISTS "content_kind" text;
ALTER TABLE "renderer_bindings" ADD COLUMN IF NOT EXISTS "ref" jsonb;
ALTER TABLE "renderer_bindings" ADD COLUMN IF NOT EXISTS "source_proposal_id" uuid;
ALTER TABLE "renderer_bindings" ADD COLUMN IF NOT EXISTS "created_by" text;
ALTER TABLE "renderer_bindings" ADD COLUMN IF NOT EXISTS "created_at" timestamptz DEFAULT now();
ALTER TABLE "renderer_bindings" ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz;

-- A 'user' row without an owner is unreadable by construction (the visibility
-- predicate floors user rows on `user_id`), and a 'workspace' row without a
-- workspace would silently widen to a pod row. Both are refused at the DB.
DO $$ BEGIN
  ALTER TABLE "renderer_bindings" ADD CONSTRAINT "renderer_bindings_scope_owner_check"
    CHECK (
      (scope_kind = 'user'      AND user_id IS NOT NULL) OR
      (scope_kind = 'workspace' AND workspace_id IS NOT NULL) OR
      (scope_kind = 'pod')
    );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ONE active binding per (scope, owner, subject, content kind). Partial on
-- `revoked_at IS NULL` so a revoked row is history, not a collision — the same
-- shape `governance_rules`' active indexes use. `coalesce` over the nullable
-- owner/subject columns because NULLs do not collide in a plain UNIQUE, which
-- would let two active whole-KIND pod bindings coexist and make resolution
-- order-dependent.
CREATE UNIQUE INDEX IF NOT EXISTS "renderer_bindings_active_unique"
  ON "renderer_bindings" (
    "scope_kind",
    coalesce("user_id", ''),
    coalesce("workspace_id"::text, ''),
    "subject_kind",
    coalesce("subject_id", ''),
    "content_kind"
  )
  WHERE "revoked_at" IS NULL;

-- Resolver's primary lookup: every active binding for a (subject_kind,
-- content_kind) pair, which the ladder then ranks in application code.
CREATE INDEX IF NOT EXISTS "renderer_bindings_subject_idx"
  ON "renderer_bindings" ("subject_kind", "content_kind")
  WHERE "revoked_at" IS NULL;

CREATE INDEX IF NOT EXISTS "renderer_bindings_source_proposal_idx"
  ON "renderer_bindings" ("source_proposal_id");
