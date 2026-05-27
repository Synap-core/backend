-- Add expression index for fast agent template queries
CREATE INDEX IF NOT EXISTS idx_users_agent_template
ON users ((agent_metadata->>'agentTemplate'))
WHERE user_type = 'agent';
