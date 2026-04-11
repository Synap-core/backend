-- Add last_health_status column to intelligence_services
-- Persists the most recent health probe result so routing and UI
-- can read it without re-pinging the service.
-- Values: 'healthy' | 'degraded' | 'unhealthy' (nullable = never checked)
ALTER TABLE intelligence_services
  ADD COLUMN IF NOT EXISTS last_health_status text;
