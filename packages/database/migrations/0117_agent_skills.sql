-- Migration: 0117_agent_skills.sql
-- Adds the agent_skills table for structured knowledge packages.
-- This is platform infrastructure, not user-authored content.

CREATE TABLE IF NOT EXISTS "agent_skills" (
  "id"          uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug"        text        NOT NULL,
  "name"        text        NOT NULL,
  "description" text,
  "topics"      text[]      NOT NULL DEFAULT ARRAY[]::text[],
  "body"        text        NOT NULL,
  "source"      text,
  "author"      text,
  "version"     text,
  "tags"        text[]      NOT NULL DEFAULT ARRAY[]::text[],
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_agent_skills_slug" ON "agent_skills" ("slug");
CREATE INDEX IF NOT EXISTS "idx_agent_skills_topics" ON "agent_skills" ("topics");
