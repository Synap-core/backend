-- 0449 — renderer bundle updates (plan ad703ccd L2, decisions D1, D2, D7, D8).
--
-- The renderer bundle becomes one more whole-package kind of the pod's
-- package updates. Three facts it needs that 0436 does not keep:
--
--   renderer_bundles.content_hash — the full digest of the installed
--     definition (`officialContentHash("renderer-bundle", definition)`), so the
--     install marker claims exactly what the comparator checks, not only the
--     12-hex version.
--
--   renderer_bundle_versions — the definitions this pod installed, the current
--     one and the one before it (N-1), each with the digest recorded at its
--     install. Undo re-installs N-1 from here after checking it still hashes
--     to that digest (D7), so a rollback works when the control plane is the
--     thing that is broken. At most two rows per slug (the install prunes).
--
--   renderer_bundle_updates — what the 10-minute after-sync pass learned from
--     the control plane's metadata read (`?meta=1`): the newest version and
--     when it was published (the soak counts from it, D1), whether the
--     installed version was retired (D8), the last refusal (a plan pod's
--     first-sync install, D2, or a pod no plan covers), a hold that waits for
--     the owner, and the owner's "Stop updates". A row exists before any
--     install, so a refusal can be shown on a pod with no bundle.
--
-- Pod-level tables: no owner, no space.

ALTER TABLE "renderer_bundles" ADD COLUMN IF NOT EXISTS "content_hash" text;

CREATE TABLE IF NOT EXISTS "renderer_bundle_versions" (
  "slug"         text        NOT NULL,
  "version"      text        NOT NULL,
  "content_hash" text        NOT NULL,
  "definition"   jsonb       NOT NULL,
  "installed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("slug", "version")
);

CREATE TABLE IF NOT EXISTS "renderer_bundle_updates" (
  "slug"                text        PRIMARY KEY,
  "latest_version"      text,
  "latest_content_hash" text,
  "latest_published_at" timestamptz,
  "checked_at"          timestamptz,
  "installed_retired"   boolean     NOT NULL DEFAULT false,
  "refusal_code"        text,
  "refusal_message"     text,
  "refused_at"          timestamptz,
  "hold_version"        text,
  "hold_reason"         text,
  "hold_detail"         text,
  "held_at"             timestamptz,
  "apply_after"         timestamptz,
  "stopped_at"          timestamptz,
  "stopped_by"          text,
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);
