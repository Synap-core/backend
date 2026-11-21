-- 0436 — renderer bundles (decision c91d26dc, spec c9b1e4d0 §3b).
--
-- A renderer bundle is a set of frame cells that draw a pod's objects (an
-- entity card, a board…) plus the ONE host-module set they run on (React,
-- react-dom, the JSX runtimes, the kit and the tokens CSS, all from one
-- build). Its cells install as `widget_definitions` rows
-- (`cell:<slug>:<key>`); this migration adds the two tables only a bundle
-- has: the bundle row and its host modules.
--
-- `defaults` (which cell a host with no built-in draws for an entity card,
-- an entity page or a view type) lives on the bundle row, NEVER in
-- `renderer_bindings`: a binding would beat the desktop's own adapters.
--
-- ONE host-module set per pod (W1): every set has a `react` module, so the
-- unique index on `module` admits one bundle's modules and refuses a second
-- slug's at the database, whatever the install door checked first.
--
-- The host modules are written BEFORE the bundle row (the row is the commit
-- marker of an install), so their foreign key is checked at commit
-- (DEFERRABLE INITIALLY DEFERRED). Pod-level tables: no owner, no space.

CREATE TABLE IF NOT EXISTS "renderer_bundles" (
  "slug"          text        PRIMARY KEY,
  "version"       text        NOT NULL,
  "set_sha256"    text        NOT NULL,
  "react_version" text        NOT NULL,
  "kit_exports"   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  "defaults"      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "source"        text        NOT NULL,
  "installed_by"  text        NOT NULL,
  "installed_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "renderer_host_modules" (
  "bundle_slug" text    NOT NULL,
  "module"      text    NOT NULL,
  "source"      text    NOT NULL,
  "sha256"      text    NOT NULL,
  "byte_length" integer NOT NULL,
  PRIMARY KEY ("bundle_slug", "module")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'renderer_host_modules_bundle_fk'
  ) THEN
    ALTER TABLE "renderer_host_modules" ADD CONSTRAINT "renderer_host_modules_bundle_fk"
      FOREIGN KEY ("bundle_slug") REFERENCES "renderer_bundles"("slug")
      ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "renderer_host_modules_one_set"
  ON "renderer_host_modules" ("module");
