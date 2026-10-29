-- 0364 — api_usage_buckets: how many calls each key, client and conversation
-- makes, per 5 minutes (pod-side plan 0d26a391, section 6.2).
--
-- Nothing counted calls before: `api_keys.usage_count` is bumped at most once
-- a minute (presence, not a count) and `http_requests_total` was never
-- incremented. One row per (5-minute bucket, dimension tuple), upserted by the
-- API's usage middleware in one batched statement a minute
-- (apps/api/src/middleware/usage-telemetry.ts). No write per request.
--
-- `limiter_key` is the rate limiter's own bucket identity, hashed (`key:<h>`,
-- `session:<h>`, `ip:<h>`), so a 429 answered BEFORE auth (no `api_key_id`)
-- still joins to the key through the rows of that limiter key that did
-- authenticate. `client` is `X-Synap-Client`, else the conversation's harness,
-- else `unknown`. Kept 30 days by the daily `api-usage-retention` job.
--
-- Telemetry, not governance lineage: no FK to api_keys (a revoked key keeps
-- its history), no user column (the read door is pod-admin only).
-- Additive; the previous release neither reads nor writes it.

CREATE TABLE IF NOT EXISTS "api_usage_buckets" (
  "bucket_start"    timestamptz NOT NULL,
  "api_key_id"      uuid,
  "limiter_key"     text        NOT NULL,
  "client"          text        NOT NULL,
  "conversation_id" text,
  "rl_class"        text        NOT NULL,
  "outcome"         text        NOT NULL,
  "calls"           integer     NOT NULL DEFAULT 0,
  "held_ms"         bigint      NOT NULL DEFAULT 0,
  CONSTRAINT "api_usage_buckets_dims_unique" UNIQUE NULLS NOT DISTINCT
    ("bucket_start", "api_key_id", "limiter_key", "client", "conversation_id", "rl_class", "outcome")
);

CREATE INDEX IF NOT EXISTS "idx_api_usage_buckets_key_time"
  ON "api_usage_buckets" ("api_key_id", "bucket_start");

CREATE INDEX IF NOT EXISTS "idx_api_usage_buckets_time"
  ON "api_usage_buckets" ("bucket_start");
