-- 0449 — renderer bundle updates: the renderer bundle becomes one more
-- whole-package kind of the pod's package updates. Three facts 0436 does not
-- keep:
--
--   renderer_bundles.content_hash — the full digest of the installed
--     definition, so the install marker claims what the comparator checks,
--     not only the 12-hex version.
--
--   renderer_bundle_versions — the definitions installed here, the current one
--     and the one before it (N-1), each with the digest recorded at install.
--     Undo re-installs N-1 from here after re-checking that digest, so it
--     works when the control plane is what is broken. At most two rows per
--     slug (the install prunes).
--
--   renderer_bundle_updates — what the 10-minute after-sync pass learned: the
--     newest version and its publish date (the soak counts from it), whether
--     the installed version was retired, why the newest version waits, a hold
--     on one version, the last refusal, and the owner's pause. The row exists
--     before any install, so a refusal shows on a pod with no bundle.
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
  "wait_reason"         text,
  "apply_after"         timestamptz,
  "paused_at"           timestamptz,
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);
