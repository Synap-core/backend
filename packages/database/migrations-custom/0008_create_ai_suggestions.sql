-- AI Suggestions inbox table

CREATE TABLE IF NOT EXISTS ai_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  payload JSONB,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_suggestions_user_status
  ON ai_suggestions (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_suggestions_type
  ON ai_suggestions (type);




