-- Migration: Default workspace Home bento view
-- Description: Inserts one "Home" bento view per workspace (metadata.homeScope = 'workspace').
-- Only workspaces that do not already have a workspace Home get one.
-- Date: 2025-02

INSERT INTO "views" (
  id,
  workspace_id,
  user_id,
  type,
  category,
  name,
  config,
  metadata,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  w.id,
  COALESCE(
    (SELECT wm.user_id FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.role IN ('owner', 'admin') ORDER BY CASE wm.role WHEN 'owner' THEN 0 ELSE 1 END LIMIT 1),
    (SELECT wm.user_id FROM workspace_members wm WHERE wm.workspace_id = w.id LIMIT 1)
  ),
  'bento',
  'composite',
  'Home',
  '{"layout":"bento","breakpoints":{"lg":{"cols":12,"rowHeight":100,"gap":16},"md":{"cols":8,"rowHeight":100,"gap":16},"sm":{"cols":4,"rowHeight":100,"gap":16}},"blocks":[{"id":"welcome","kind":"widget","widgetType":"welcome","pos":{"x":0,"y":0,"w":12,"h":2}},{"id":"quick-access","kind":"widget","widgetType":"quick-access","pos":{"x":0,"y":2,"w":4,"h":2}},{"id":"recent","kind":"widget","widgetType":"recent-items","pos":{"x":0,"y":4,"w":4,"h":4}},{"id":"feed","kind":"widget","widgetType":"feed","pos":{"x":0,"y":8,"w":4,"h":6}},{"id":"calendar","kind":"widget","widgetType":"calendar","pos":{"x":4,"y":2,"w":8,"h":12}}]}'::jsonb,
  '{"homeScope":"workspace"}'::jsonb,
  NOW(),
  NOW()
FROM workspaces w
WHERE EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id)
  AND NOT EXISTS (
    SELECT 1 FROM "views" v
    WHERE v.workspace_id = w.id
      AND v.type = 'bento'
      AND (v.metadata->>'homeScope') = 'workspace'
  );
