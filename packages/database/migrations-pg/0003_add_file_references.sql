-- V0.3 Migration: Add File Storage References
-- This migration adds fields to support external file storage (R2/S3)

-- Add file reference columns to entities table
ALTER TABLE entities 
  ADD COLUMN file_url TEXT,
  ADD COLUMN file_path TEXT,
  ADD COLUMN file_size INTEGER,
  ADD COLUMN file_type TEXT CHECK (file_type IN ('markdown', 'pdf', 'audio', 'video', 'image')),
  ADD COLUMN checksum TEXT;

-- Create index on checksum for deduplication
CREATE INDEX idx_entities_checksum ON entities(checksum) WHERE checksum IS NOT NULL;

-- Create index on file_path for lookups
CREATE INDEX idx_entities_file_path ON entities(file_path) WHERE file_path IS NOT NULL;

-- Comment on columns
COMMENT ON COLUMN entities.file_url IS 'Public URL for accessing the file (e.g., https://r2.../users/123/notes/456.md)';
COMMENT ON COLUMN entities.file_path IS 'Storage key/path (e.g., users/123/notes/456.md)';
COMMENT ON COLUMN entities.file_size IS 'File size in bytes';
COMMENT ON COLUMN entities.file_type IS 'MIME type category (markdown, pdf, audio, video, image)';
COMMENT ON COLUMN entities.checksum IS 'SHA256 checksum for integrity verification (format: sha256:base64hash)';

