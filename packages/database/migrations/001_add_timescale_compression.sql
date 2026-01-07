-- TimescaleDB Compression Policy
-- 
-- Compresses events older than 7 days to save ~90% storage
-- 
-- Run this migration after TimescaleDB extension is enabled

-- Enable compression on events_timescale table
ALTER TABLE events_timescale SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'user_id, subject_type',
  timescaledb.compress_orderby = 'timestamp DESC'
);

-- Add compression policy: compress chunks older than 7 days
SELECT add_compression_policy('events_timescale', INTERVAL '7 days');

-- Compress existing old chunks immediately (run once)
SELECT compress_chunk(i) 
FROM show_chunks('events_timescale', older_than => INTERVAL '7 days') i;

-- Verify compression
SELECT 
  chunk_schema,
  chunk_name,
  compression_status,
  before_compression_total_bytes,
  after_compression_total_bytes
FROM timescaledb_information.compressed_chunk_stats
ORDER BY chunk_name DESC;
