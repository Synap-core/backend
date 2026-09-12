-- 0257_mcp_servers_auth_and_tool_policy.sql
--
-- Remote MCP servers become governable, installable config.
--
-- `auth` — how the pod authenticates to an HTTP MCP server, WITHOUT storing the
--   secret on the row: { "credentialRef": "vault://<id>", "header": "Authorization",
--   "prefix": "Bearer " }. The pod resolves the vault secret server-side and sends
--   the header to the IS transport; the agent never sees it.
--
-- `tool_policy` — which of the server's tools an agent may call INLINE, and which
--   must go through the pod's governance door (proposal-gated for agents):
--   { "default": "governed" | "inline", "inline": ["tool_a", ...] }.
--   NULL means GOVERNED. This is deliberate and fail-closed: the database cannot
--   tell which already-installed servers expose only reads, so none is assumed
--   safe. A template that knows its server is read-only declares
--   { "default": "inline" }; one with mixed tools lists its reads.

ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "auth" jsonb;
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "tool_policy" jsonb;
