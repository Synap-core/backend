-- TimescaleDB Compression Policy
-- 
-- Compresses events older than 7 days to save ~90% storage
-- 
-- Run this migration after TimescaleDB extension is enabled

-- Enable compression on events table
ALTER TABLE events SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'user_id, subject_type',
  timescaledb.compress_orderby = 'timestamp DESC'
);

-- Add compression policy: compress chunks older than 7 days
SELECT add_compression_policy('events', INTERVAL '7 days');

-- Compress existing old chunks immediately (run once)
SELECT compress_chunk(i) 
FROM show_chunks('events', older_than => INTERVAL '7 days') i;

-- Verify compression
SELECT * FROM hypertable_compression_stats('events');
