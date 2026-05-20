-- 0024_profile_renderer_columns.sql
-- Phase 1 of the Profile Renderer North Star — add JSONB columns to `profiles`
-- carrying the system-default renderer choice per slot (list / detail).
--
-- Spec: synap-team-docs/content/team/platform/profile-renderer.mdx
--
-- Each column stores a RendererTarget shape (defined by @synap-core/renderer-runtime):
--   { kind: 'cell',          cellKey, props }       — config path (registered)
--   { kind: 'view',          viewId }               — config path (saved view)
--   { kind: 'iframe-srcdoc', appId, srcdoc }        — file path (inline bundle)
--   { kind: 'external-app',  appId, url }           — file path (pod-served URL)
--   { kind: 'url',           url }                  — passthrough
--
-- Workspace-level overrides live in workspaces.settings.profileRenderers (a new
-- key inside the existing JSONB settings column — no DDL needed for that side,
-- mirroring how profileBentoViewIds is stored).
--
-- Resolution chain (ProfileResolutionService.getEffectiveRenderer):
--   workspace overlay → profile system default (these columns) → hardcoded fallback
--
-- Idempotent. Defensive. Re-running is a no-op.

BEGIN;

ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "default_list_renderer"   jsonb;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "default_detail_renderer" jsonb;

COMMIT;
