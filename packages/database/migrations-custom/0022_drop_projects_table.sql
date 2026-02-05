-- Migration: Drop projects table
-- Description: Drops the projects table since projects are now entities
-- Date: 2025-02-04
-- NOTE: This migration should run AFTER 0020_migrate_projects_to_entities.sql and 0021_remove_project_ids_columns.sql

DO $$
BEGIN
    -- Drop projects table if it exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'projects') THEN
        -- Drop indexes first
        IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'projects_user_id_idx') THEN
            DROP INDEX "projects_user_id_idx";
        END IF;
        IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'projects_status_idx') THEN
            DROP INDEX "projects_status_idx";
        END IF;
        
        -- Drop table
        DROP TABLE "projects";
        RAISE NOTICE 'Dropped projects table';
    ELSE
        RAISE NOTICE 'Projects table does not exist, skipping';
    END IF;
END $$;
