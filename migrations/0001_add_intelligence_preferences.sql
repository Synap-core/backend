-- Add intelligence service preferences to user_preferences
-- This field stores user's preferred intelligence services for different capabilities

ALTER TABLE user_preferences
ADD COLUMN IF NOT EXISTS intelligence_service_preferences JSONB DEFAULT '{}' NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN user_preferences.intelligence_service_preferences IS 
'User preferences for intelligence services. Structure: { default?: string, chat?: string, analysis?: string }';

-- No changes needed for workspaces table (settings is already JSONB with proper type)
