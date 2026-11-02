-- 0389 — a runner says which model it runs on, and which provider serves it
-- (decision 5e7c77dc, research document 646fbb16): facts a client reports,
-- never part of the agent's identity (owner × computer × harness).
--
-- Any harness adapter names them on any key-auth call (MCP or Hub REST) with
-- `X-Synap-Model: <model id>` and `X-Synap-Model-Provider: <slug>` (MCP clients
-- that cannot set headers: `_meta["live.synap/model"]` /
-- `_meta["live.synap/modelProvider"]`). The pod parses them by the one rule in
-- `@synap-core/types/agents` (`model-providers.ts`) and stamps them on the
-- request's events (`events.model` / `events.provider`, which exist since 0131)
-- and on the wait's runner row here.
--
--   model     the model id as the client names it; NULL = unknown
--   provider  a MODEL_PROVIDERS slug (`other` for an unlisted one); NULL =
--             unknown, never "anthropic"; never a URL
--
-- Telemetry like state: no governance, no NOTIFY.
--
-- Fresh installs get all of this from 0000_baseline_schema.sql.

ALTER TABLE "session_runners" ADD COLUMN IF NOT EXISTS "model" text;
ALTER TABLE "session_runners" ADD COLUMN IF NOT EXISTS "provider" text;
