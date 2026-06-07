-- Profile "dashboard" renderer slot (third slot alongside list + detail).
-- Holds a RendererTarget (a `{ kind:'view', viewId }` ref to a bento view scoped
-- like the profile). Workspace overrides live in
-- workspaces.settings.profileRenderers[slug].dashboard. Resolved by
-- ProfileResolutionService.getEffectiveRenderer(slot='dashboard').
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "default_dashboard_renderer" jsonb;
