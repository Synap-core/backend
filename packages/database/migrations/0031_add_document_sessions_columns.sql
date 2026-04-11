-- Add missing columns to document_sessions table
-- Part of Document Editing Sessions feature (B2)

-- Add chat_thread_id column
ALTER TABLE document_sessions
ADD COLUMN IF NOT EXISTS chat_thread_id UUID NOT NULL DEFAULT gen_random_uuid();

-- Add is_active column
ALTER TABLE document_sessions
ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- Add started_at column
ALTER TABLE document_sessions
ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Add ended_at column
ALTER TABLE document_sessions
ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;

-- Add active_collaborators column
ALTER TABLE document_sessions
ADD COLUMN IF NOT EXISTS active_collaborators JSONB;

-- Drop old columns that are no longer used
ALTER TABLE document_sessions
DROP COLUMN IF EXISTS cursor_position,
DROP COLUMN IF EXISTS selection,
DROP COLUMN IF EXISTS active_at;

-- Add index for active sessions
CREATE INDEX IF NOT EXISTS document_sessions_active_idx
ON document_sessions(is_active) WHERE is_active = true;

-- Add index for chat thread lookups
CREATE INDEX IF NOT EXISTS document_sessions_chat_thread_idx
ON document_sessions(chat_thread_id);
