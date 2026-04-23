-- Migration 0013: Knowledge keys table
--
-- Stores pod-wide operational documentation (how to deploy, fix, build).
-- Complements knowledge_facts (per-user episodic memory) with
-- pod-wide procedural knowledge accessible by structured lookup.
-- Key format: namespace:slug (e.g. "deploy:backend", "ui:tokens")

BEGIN;

-- ── 1. Create knowledge_keys table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key VARCHAR(256) NOT NULL UNIQUE,
    namespace VARCHAR(64) NOT NULL,
    slug VARCHAR(128) NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    workspace_id UUID,
    version INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    author VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2. Indexes ────────────────────────────────────────────────────────────────
-- Full-text search on value (PostgreSQL GIN)
DROP INDEX IF EXISTS idx_knowledge_value_ft;
CREATE INDEX idx_knowledge_value_ft ON knowledge_keys
    USING gin (to_tsvector('simple', value));

-- Browse by namespace
DROP INDEX IF EXISTS idx_knowledge_namespace;
CREATE INDEX IF NOT EXISTS idx_knowledge_namespace ON knowledge_keys(namespace);

-- Filter by status
DROP INDEX IF EXISTS idx_knowledge_status;
CREATE INDEX IF NOT EXISTS idx_knowledge_status ON knowledge_keys(status);

-- Workspace-scoped filtering
DROP INDEX IF EXISTS idx_knowledge_workspace;
CREATE INDEX IF NOT EXISTS idx_knowledge_workspace ON knowledge_keys(workspace_id);

-- ── 3. Seed default knowledge keys ───────────────────────────────────────────
INSERT INTO knowledge_keys (key, namespace, slug, value) VALUES
('deploy:backend', 'deploy', 'backend', E'# Backend Deploy\n\nStep-by-step guide for deploying the backend service.\n\n## Setup\n\n1. Ensure PostgreSQL is running\n2. Run migrations: `cd synap-backend && pnpm drizzle-kit migrate`\n3. Start dev server: `pnpm dev`\n4. Backend runs on port 4000\n\n## Prerequisites\n\n- Node.js 18+\n- PostgreSQL 14+\n- pgvector extension enabled'),

('deploy/frontend', 'deploy', 'frontend', E'# Frontend Deploy\n\n## Setup\n\n1. From synap-app: `pnpm dev`\n2. Frontend runs on port 3000\n\n## Prerequisites\n\n- pnpm installed\n- monorepo dependencies installed (`pnpm install`)'),

('ui:tokens', 'ui', 'tokens', E'# UI Tokens\n\nSynap uses Tamagui tokens from @synap-core/ui-system.\n\n## Colors\n\nUse $primary, $background, $color, $borderColor — NEVER hex values.\n\n## Spacing\n\nUse $1 (6px), $2 (12px), $4 (24px). NEVER hardcode.\n\n## Sizes\n\nUse $8 (32px), $10 (40px), $12 (48px) for heights.'),

('architecture:composable', 'architecture', 'composable', E'# Composable Architecture\n\nSynap is built on a Lego brick model:\n\n- **Entities** = data bricks\n- **Views** = environments where bricks combine\n- **Cells** = universal renderer unit\n\nAll UI is composable: any cell on any view, any view on any dashboard.')
ON CONFLICT (key) DO NOTHING;

COMMIT;
