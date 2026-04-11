-- Migration: Add scope profiles and consolidate view query/config
-- Description: Adds scopeProfileIds, query, config columns and consolidates legacy columns
-- Date: 2025-02-04

-- ============================================================================
-- VIEWS SCHEMA UPDATE - SCOPE PROFILES & CONSOLIDATED QUERY/CONFIG
-- ============================================================================

DO $$ 
BEGIN
    -- Add scopeProfileIds (array of profile UUIDs)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'views' AND column_name = 'scope_profile_ids') THEN
        ALTER TABLE "views" ADD COLUMN "scope_profile_ids" uuid[];
        
        -- Add comment
        COMMENT ON COLUMN "views"."scope_profile_ids" IS 'Declared schema scope - profiles this view is intended to show (stable anchor for deterministic defaults)';
    END IF;

    -- Add scopeMode (optional)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'views' AND column_name = 'scope_mode') THEN
        ALTER TABLE "views" ADD COLUMN "scope_mode" text;
        
        -- Add comment
        COMMENT ON COLUMN "views"."scope_mode" IS 'How scope was determined: explicit (user-selected) or observed (inferred from results)';
    END IF;

    -- Add query column (consolidated query structure)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'views' AND column_name = 'query') THEN
        ALTER TABLE "views" ADD COLUMN "query" jsonb DEFAULT '{}'::jsonb;
        
        -- Add comment
        COMMENT ON COLUMN "views"."query" IS 'Consolidated query: { filters, sorts, search, limit, offset, groupBy }';
    END IF;

    -- Add config column (render overrides only)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'views' AND column_name = 'config') THEN
        ALTER TABLE "views" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb;
        
        -- Add comment
        COMMENT ON COLUMN "views"."config" IS 'Render overrides (deltas from defaults): { hiddenColumns, visibleColumns, columnOrder, columnWidths, ... }';
    END IF;

    -- Add schemaSnapshot (optional cache)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'views' AND column_name = 'schema_snapshot') THEN
        ALTER TABLE "views" ADD COLUMN "schema_snapshot" jsonb;
        
        -- Add comment
        COMMENT ON COLUMN "views"."schema_snapshot" IS 'Cached property info from scopeProfileIds (performance optimization, not source of truth)';
    END IF;

    -- Add snapshotUpdatedAt
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'views' AND column_name = 'snapshot_updated_at') THEN
        ALTER TABLE "views" ADD COLUMN "snapshot_updated_at" timestamp with time zone;
    END IF;
END $$;

-- ============================================================================
-- MIGRATE EXISTING VIEWS
-- ============================================================================

-- Step 1: Migrate entityTypes to scopeProfileIds (from metadata.config.query.entityTypes)
UPDATE "views" v
SET "scope_profile_ids" = (
  SELECT array_agg(p.id)
  FROM "profiles" p
  WHERE p.slug = ANY(
    SELECT jsonb_array_elements_text(
      COALESCE(
        v.metadata->'config'->'query'->'entityTypes',
        '[]'::jsonb
      )
    )
  )
)
WHERE v.category = 'structured'
  AND v.metadata->'config'->'query'->'entityTypes' IS NOT NULL
  AND v.metadata->'config'->'query'->'entityTypes' != '[]'::jsonb
  AND (v.scope_profile_ids IS NULL OR array_length(v.scope_profile_ids, 1) IS NULL);

-- Step 2: Set scopeMode to 'explicit' for migrated views
UPDATE "views"
SET "scope_mode" = 'explicit'
WHERE "scope_profile_ids" IS NOT NULL
  AND array_length("scope_profile_ids", 1) > 0
  AND "scope_mode" IS NULL;

-- Step 3: Consolidate query (merge filter, sort, and metadata.config.query)
UPDATE "views" v
SET "query" = jsonb_build_object(
  'filters', COALESCE(
    v.filter,
    v.metadata->'config'->'query'->'filters',
    '[]'::jsonb
  ),
  'sorts', COALESCE(
    v.sort,
    v.metadata->'config'->'query'->'sorts',
    '[]'::jsonb
  ),
  'search', COALESCE(
    v.metadata->'config'->'query'->'search',
    NULL
  ),
  'limit', COALESCE(
    (v.metadata->'config'->'query'->>'limit')::int,
    100
  ),
  'offset', COALESCE(
    (v.metadata->'config'->'query'->>'offset')::int,
    0
  ),
  'groupBy', COALESCE(
    v.metadata->'config'->'query'->>'groupBy',
    NULL
  )
)
WHERE v.category = 'structured'
  AND (v.query IS NULL OR v.query = '{}'::jsonb);

-- Step 4: Consolidate config (merge columns and layoutConfig)
UPDATE "views" v
SET "config" = jsonb_build_object(
  'columns', COALESCE(
    v.columns,
    v.metadata->'config'->'render'->'columns',
    '[]'::jsonb
  ),
  'layout', COALESCE(
    v.layout_config,
    v.metadata->'config'->'render'->'layout',
    '{}'::jsonb
  )
)
WHERE v.category = 'structured'
  AND (v.config IS NULL OR v.config = '{}'::jsonb);

-- ============================================================================
-- NOTES
-- ============================================================================
-- This migration:
-- 1. Adds scopeProfileIds (declared schema scope)
-- 2. Adds query column (consolidated filters/sorts/search)
-- 3. Adds config column (render overrides only)
-- 4. Migrates existing views from entityTypes to scopeProfileIds
-- 5. Consolidates filter/sort/columns/layoutConfig into query/config
-- 6. Legacy columns (filter, sort, columns, layoutConfig) kept for backward compatibility
-- 7. These legacy columns will be removed in a future migration after full migration
