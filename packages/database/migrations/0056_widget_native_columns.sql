-- 0056_widget_native_columns.sql
-- Add columns for native dynamic widgets (Grafana shared-externals model).
-- source: original JSX/TSX source code (for editing)
-- bundle_source: compiled IIFE bundle (for runtime loading)
-- These are only populated when renderer_type = 'native'.

ALTER TABLE widget_definitions
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS bundle_source text;
