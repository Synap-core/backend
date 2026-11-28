-- 0413_composite_indexes_exposure
--
-- Composite indexes matching the query patterns of entities.list and
-- accessScopeWhere (access layer) — identified in the same 3-second-load
-- performance investigation as 0412 (session 9a663a59).

-- entities.list: isNull(deletedAt) + type + workspace_id + ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS entities_list_type_ws_created_idx
ON entities (deleted_at, type, workspace_id, created_at DESC);

-- accessScopeWhere: relations by (type, target_entity_id) (exposure subqueries)
CREATE INDEX IF NOT EXISTS relations_type_target_idx
ON relations (type, target_entity_id);

-- accessScopeWhere: project_members by (user_id, role) (guest/member split)
CREATE INDEX IF NOT EXISTS project_members_user_role_idx
ON project_members (user_id, role);

-- facet visibility: entity_facets by (workspace_id, profile_id, deleted_at, entity_id)
CREATE INDEX IF NOT EXISTS entity_facets_ws_profile_deleted_entity_idx
ON entity_facets (workspace_id, profile_id, deleted_at, entity_id);
