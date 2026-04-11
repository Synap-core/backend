-- Migration: Add view composition support (embedded_view_ids)
-- Description: Adds embedded_view_ids column for composite views (bento grid)
-- Date: 2025-02-04

-- ============================================================================
-- VIEW COMPOSITION SUPPORT
-- ============================================================================

DO $$ 
BEGIN
    -- Add embedded_view_ids column (array of view UUIDs)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'views' AND column_name = 'embedded_view_ids') THEN
        ALTER TABLE "views" ADD COLUMN "embedded_view_ids" uuid[];
        
        -- Add comment
        COMMENT ON COLUMN "views"."embedded_view_ids" IS 'Views embedded in this view (for composite views like bento grid)';
    END IF;
END $$;

-- Add GIN index for efficient array queries
CREATE INDEX IF NOT EXISTS idx_views_embedded_view_ids 
  ON "views" USING GIN("embedded_view_ids");

-- Optional: Add constraint to prevent self-reference
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'check_no_self_embed'
    ) THEN
        ALTER TABLE "views" ADD CONSTRAINT check_no_self_embed 
          CHECK (id != ALL(embedded_view_ids));
    END IF;
END $$;
