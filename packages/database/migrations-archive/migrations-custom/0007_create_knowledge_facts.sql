-- Knowledge Facts table for Super Memory (V0.5)

CREATE TABLE IF NOT EXISTS knowledge_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  source_entity_id UUID,
  source_message_id UUID,
  confidence REAL NOT NULL DEFAULT 0.5,
  embedding VECTOR(1536) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_facts_user_created
  ON knowledge_facts (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_facts_source_entity
  ON knowledge_facts (source_entity_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_facts_source_message
  ON knowledge_facts (source_message_id);




