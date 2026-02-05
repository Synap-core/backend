-- Migration: Migrate Projects to Entities
-- Description: Converts projects table to entities with "project" profile, and converts projectIds arrays to relations
-- Date: 2025-02-04

DO $$
DECLARE
    project_profile_id uuid;
    project_record RECORD;
    entity_record RECORD;
    project_id_val uuid;
BEGIN
    -- Step 1: Ensure "project" profile exists (get or create)
    SELECT id INTO project_profile_id FROM profiles WHERE slug = 'project' AND scope = 'system' LIMIT 1;
    
    IF project_profile_id IS NULL THEN
        -- Create project profile if it doesn't exist
        INSERT INTO profiles (slug, display_name, ui_hints, scope, is_active, version)
        VALUES (
            'project',
            'Project',
            '{"icon": "folder", "color": "#8B5CF6"}'::jsonb,
            'system',
            true,
            1
        )
        RETURNING id INTO project_profile_id;
        
        RAISE NOTICE 'Created project profile: %', project_profile_id;
    ELSE
        RAISE NOTICE 'Using existing project profile: %', project_profile_id;
    END IF;

    -- Step 2: Convert existing projects to entities
    RAISE NOTICE 'Converting projects to entities...';
    
    FOR project_record IN SELECT * FROM projects LOOP
        -- Check if entity already exists (idempotent)
        IF NOT EXISTS (SELECT 1 FROM entities WHERE id = project_record.id) THEN
            INSERT INTO entities (
                id,
                user_id,
                workspace_id,
                profile_id,
                type,
                title,
                preview,
                properties,
                version,
                created_at,
                updated_at
            )
            VALUES (
                project_record.id,
                project_record.user_id,
                project_record.workspace_id,
                project_profile_id,
                'project',
                project_record.name,
                project_record.description,
                jsonb_build_object(
                    'status', COALESCE(project_record.status, 'active'),
                    'description', project_record.description,
                    'settings', COALESCE(project_record.settings, '{}'::jsonb),
                    'metadata', COALESCE(project_record.metadata, '{}'::jsonb)
                ),
                1,
                project_record.created_at,
                project_record.updated_at
            );
            
            RAISE NOTICE 'Converted project % to entity', project_record.id;
        ELSE
            RAISE NOTICE 'Entity % already exists, skipping', project_record.id;
        END IF;
    END LOOP;

    -- Step 3: Convert projectIds arrays to relations (type: "belongs_to_project")
    -- NOTE: Relations only work between entities, so we only migrate entities' projectIds
    RAISE NOTICE 'Converting entities projectIds arrays to relations...';
    
    FOR entity_record IN SELECT id, project_ids, user_id, workspace_id FROM entities WHERE project_ids IS NOT NULL AND array_length(project_ids, 1) > 0 LOOP
        FOREACH project_id_val IN ARRAY entity_record.project_ids LOOP
            -- Verify project exists as entity
            IF EXISTS (SELECT 1 FROM entities WHERE id = project_id_val AND type = 'project') THEN
                -- Create relation if it doesn't exist (idempotent)
                IF NOT EXISTS (
                    SELECT 1 FROM relations 
                    WHERE source_entity_id = entity_record.id 
                    AND target_entity_id = project_id_val 
                    AND type = 'belongs_to_project'
                ) THEN
                    INSERT INTO relations (
                        user_id,
                        workspace_id,
                        source_entity_id,
                        target_entity_id,
                        type,
                        created_at
                    )
                    VALUES (
                        entity_record.user_id,
                        entity_record.workspace_id,
                        entity_record.id,
                        project_id_val,
                        'belongs_to_project',
                        NOW()
                    );
                END IF;
            END IF;
        END LOOP;
    END LOOP;

    RAISE NOTICE 'Migration completed successfully';
END $$;
