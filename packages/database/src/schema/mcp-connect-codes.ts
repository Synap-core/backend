/**
 * MCP Connect Codes Schema — Drizzle ORM
 *
 * One-time consent codes for the CP-MCP pod-accept gate (MCP-OAUTH-AND-CONNECT-PLAN §2-3).
 *
 * FLOW: when a user authorizes the control plane (CP) to reach their pod's MCP,
 * pod-admin's `/connect` page mints a short-lived consent code (session-authed,
 * via `apiKeys.beginMcpConnect`) and top-level-navigates to the CP callback with
 * ONLY the code — never a plaintext key. The CP then redeems the code
 * server-to-server (POST /api/hub/mcp/redeem, master-key Bearer), and the pod
 * mints the `claude-web` agent key AT REDEEM time.
 *
 * SECURITY: only a HASH of the code is stored (sha256, same lookup-hash pattern
 * as api_keys.key_lookup_hash) — the raw code is returned to the browser once and
 * never persisted. Single-use (consumed_at) + short TTL (expires_at, ~10 min).
 */

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const mcpConnectCodes = pgTable("mcp_connect_codes", {
  // sha256(rawCode) — the PK and the only representation of the code we store.
  codeHash: text("code_hash").primaryKey(),

  // The human (pod user) who authorized CP. The minted agent key's
  // linkedUserId is set to this so the agent acts for the right human.
  podUserId: text("pod_user_id").notNull(),

  // CP-grammar scopes requested at authorization time (e.g. ["mcp:read","mcp:write"]).
  // Mapped to pod api_keys grammar at redeem, before minting.
  scopes: text("scopes").array().notNull().default([]),

  // Always "claude-web" today — kept explicit so the redeem path can branch.
  agentType: text("agent_type").notNull(),

  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),

  // Short TTL — redeem rejects an expired code.
  expiresAt: timestamp("expires_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),

  // Single-use marker. NULL = unconsumed. Set atomically at redeem to prevent
  // a double-redeem race.
  consumedAt: timestamp("consumed_at", { mode: "date", withTimezone: true }),
});
