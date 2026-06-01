-- Add 'frame' renderer type and deps column to widget_definitions
-- 'frame' renderer: raw ESM code stored as-is (no JSX compile step)
-- deps: npm package version pins e.g. { 'recharts': '2.12.0' }

-- renderer_type is stored as text (not a PG enum), so no ALTER TYPE needed.
-- Just add the deps column.
ALTER TABLE widget_definitions ADD COLUMN IF NOT EXISTS deps JSONB DEFAULT '{}';
