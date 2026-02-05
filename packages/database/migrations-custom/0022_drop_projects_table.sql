-- Migration: Drop projects table and project_members table
-- Description: Drops the projects and project_members tables since projects are now entities
-- Date: 2025-02-04
-- NOTE: This migration should run AFTER 0020_migrate_projects_to_entities.sql and 0021_remove_project_ids_columns.sql

DO $$
BEGIN
    -- Drop project_members table first (has FK dependency on projects)
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'project_members') THEN
        -- Drop indexes first
        IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_project_members_project') THEN
            DROP INDEX "idx_project_members_project";
        END IF;
        IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_project_members_user') THEN
            DROP INDEX "idx_project_members_user";
        END IF;
        IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_project_members_user_project') THEN
            DROP INDEX "idx_project_members_user_project";
        END IF;
        IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'project_user_unique') THEN
            DROP INDEX "project_user_unique";
        END IF;
        
        -- Drop table
        DROP TABLE "project_members" CASCADE;
        RAISE NOTICE 'Dropped project_members table';
    ELSE
        RAISE NOTICE 'project_members table does not exist, skipping';
    END IF;
    
    -- Drop projects table if it exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'projects') THEN
        -- Drop indexes first
        IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'projects_user_id_idx') THEN
            DROP INDEX "projects_user_id_idx";
        END IF;
        IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'projects_status_idx') THEN
            DROP INDEX "projects_status_idx";
        END IF;
        
        -- Drop table (CASCADE in case there are any remaining dependencies)
        DROP TABLE "projects" CASCADE;
        RAISE NOTICE 'Dropped projects table';
    ELSE
        RAISE NOTICE 'Projects table does not exist, skipping';
    END IF;
END $$;
