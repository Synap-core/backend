-- Ebbinghaus relevance decay for episodic memory
--
-- Adds three columns to knowledge_facts:
--   access_count      — how many times this fact has been recalled
--   last_accessed_at  — timestamp of most recent recall
--   relevance_score   — Ebbinghaus decay score R = e^(-t/S), updated daily by memory-decay worker
--
-- Decay formula: R = GREATEST(0.05, EXP(-days_since_access / (1 + access_count * 0.5)))
-- More accesses → larger stability S → slower decay → higher long-term relevance.

ALTER TABLE knowledge_facts
  ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS relevance_score REAL NOT NULL DEFAULT 1.0;

CREATE INDEX IF NOT EXISTS idx_knowledge_facts_relevance
  ON knowledge_facts(relevance_score DESC)
  WHERE relevance_score < 1.0;
