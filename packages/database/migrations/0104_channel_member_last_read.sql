-- Channel member last-read tracking for unread count computation.
ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;
