-- Migration: Remove projectIds columns from all tables
-- Description: Removes project_ids array columns since we now use relations table for project linking
-- Date: 2025-02-04
-- NOTE: This migration should run AFTER 0020_migrate_projects_to_entities.sql

DO $$
BEGIN
    -- Remove projectIds from entities (already migrated to relations)
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'entities' AND column_name = 'project_ids') THEN
        ALTER TABLE "entities" DROP COLUMN "project_ids";
        RAISE NOTICE 'Removed project_ids from entities';
    END IF;

    -- Remove projectIds from documents (not entities, so no migration needed)
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'project_ids') THEN
        ALTER TABLE "documents" DROP COLUMN "project_ids";
        RAISE NOTICE 'Removed project_ids from documents';
    END IF;

    -- Remove projectIds from views (queries, not entities)
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'views' AND column_name = 'project_ids') THEN
        ALTER TABLE "views" DROP COLUMN "project_ids";
        RAISE NOTICE 'Removed project_ids from views';
    END IF;

    -- Remove projectIds from chat_threads (infrastructure, not entities)
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'chat_threads' AND column_name = 'project_ids') THEN
        -- Drop index first
        IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'chat_threads_project_ids_idx') THEN
            DROP INDEX "chat_threads_project_ids_idx";
        END IF;
        ALTER TABLE "chat_threads" DROP COLUMN "project_ids";
        RAISE NOTICE 'Removed project_ids from chat_threads';
    END IF;

    -- Remove projectIds from relations (already migrated to relations)
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'relations' AND column_name = 'project_ids') THEN
        ALTER TABLE "relations" DROP COLUMN "project_ids";
        RAISE NOTICE 'Removed project_ids from relations';
    END IF;

    -- Remove projectIds from entity_templates (not entities)
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'entity_templates' AND column_name = 'project_ids') THEN
        ALTER TABLE "entity_templates" DROP COLUMN "project_ids";
        RAISE NOTICE 'Removed project_ids from entity_templates';
    END IF;

    -- Remove projectIds from inbox_items (not entities)
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inbox_items' AND column_name = 'project_ids') THEN
        ALTER TABLE "inbox_items" DROP COLUMN "project_ids";
        RAISE NOTICE 'Removed project_ids from inbox_items';
    END IF;

    RAISE NOTICE 'Migration completed: All project_ids columns removed';
END $$;
