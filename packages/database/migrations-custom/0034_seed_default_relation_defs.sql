-- Seed default relation definitions for all existing workspaces
-- These were previously hardcoded in RelationTypeSchema / RELATION_TYPE_METADATA.
-- Now they live as relation_defs rows, one set per workspace.

INSERT INTO relation_defs (slug, display_name, description, workspace_id, user_id, is_directional, ui_hints)
SELECT d.slug, d.display_name, d.description, w.id, w.owner_id, d.is_directional, d.ui_hints
FROM workspaces w
CROSS JOIN (VALUES
  ('assigned_to',        'Assigned To',          'Person assigned to task/project',          true,  '{"category":"workflow"}'::jsonb),
  ('blocks',             'Blocks',               'Prevents progress on another task',        true,  '{"category":"workflow"}'::jsonb),
  ('depends_on',         'Depends On',           'Requires completion of another task',      true,  '{"category":"workflow"}'::jsonb),
  ('relates_to',         'Relates To',           'General relationship between entities',    false, '{"category":"reference"}'::jsonb),
  ('mentions',           'Mentions',             'Referenced in content',                    true,  '{"category":"reference"}'::jsonb),
  ('links_to',           'Links To',             'Hyperlink or reference',                   true,  '{"category":"reference"}'::jsonb),
  ('parent_of',          'Parent Of',            'Hierarchical parent relationship',         true,  '{"category":"hierarchy"}'::jsonb),
  ('tagged_with',        'Tagged With',          'Categorization tag',                       true,  '{"category":"reference"}'::jsonb),
  ('created_by',         'Created By',           'Author or creator',                        true,  '{"category":"social"}'::jsonb),
  ('attended_by',        'Attended By',          'Participant in event',                     true,  '{"category":"social"}'::jsonb),
  ('belongs_to_project', 'Belongs To Project',   'Project membership',                       true,  '{"category":"hierarchy"}'::jsonb),
  ('references',         'References',           'Cites or refers to',                       true,  '{"category":"reference"}'::jsonb)
) AS d(slug, display_name, description, is_directional, ui_hints)
ON CONFLICT (slug, workspace_id) DO NOTHING;
