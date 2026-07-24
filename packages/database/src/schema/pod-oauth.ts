/**
 * Pod-as-Authorization-Server Schema — Drizzle ORM
 *
 * Path B of claude.ai MCP connectivity: the pod IS the OAuth 2.1 authorization
 * server, so a user who does not want the control plane in their trust path can
 * point claude.ai directly at `https://<pod>/mcp`. Path A (CP-as-AS + consent
 * code, `mcp_connect_codes`) is untouched and keeps working — the two paths are
 * separable in the data by the agent type they mint (`claude-web` vs
 * `claude-web-direct`).
 *
 * TWO tables, both pod-local:
 *
 *   oauth_clients              — RFC 7591 dynamically-registered clients. Every
 *                                row is a PUBLIC client (no secret): claude.ai
 *                                registers per connection and authenticates the
 *                                code exchange with PKCE alone.
 *   oauth_authorization_codes  — short-lived, single-use authorization codes
 *                                bound to a PKCE challenge.
 *
 * SECURITY: like `mcp_connect_codes`, only a sha256 HASH of the authorization
 * code is stored (`code_hash` PK, the same lookup-hash pattern as
 * `api_keys.key_lookup_hash`). The raw code goes to the client's redirect_uri
 * once and is never persisted. Single-use is enforced by an atomic
 * `UPDATE … WHERE consumed_at IS NULL … RETURNING`, so a replayed code can
 * never mint two access tokens.
 *
 * The ACCESS TOKEN itself is NOT stored here — it is an `api_keys` row minted
 * by `provisionSurfaceAgentKey` at the token endpoint, which is the pod's one
 * and only bearer-token model.
 */

import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

export const oauthClients = pgTable("oauth_clients", {
  // RFC 7591 §3.2.1 `client_id`. Generated (`dcr_<random>`), never client-chosen.
  clientId: text("client_id").primaryKey(),

  // `client_name` from the registration request, shown verbatim on the consent
  // screen. Untrusted, attacker-controlled display text — the consent UI must
  // render it as text and never as markup.
  clientName: text("client_name").notNull(),

  // Exact-match allowlist. Registration accepts https URIs only, and
  // /authorize + /token both compare the incoming redirect_uri byte-for-byte
  // against this list (no prefix matching — that is an open-redirect hole).
  redirectUris: text("redirect_uris").array().notNull().default([]),

  // Pod-grammar scopes this client may ever be granted (`mcp.read`/`mcp.write`
  // and their `hub-protocol.*` peers). The authorize step intersects the
  // requested scopes with this list.
  scopes: text("scopes").array().notNull().default([]),

  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const oauthAuthorizationCodes = pgTable(
  "oauth_authorization_codes",
  {
    // sha256(rawCode) — the only representation of the code we store.
    codeHash: text("code_hash").primaryKey(),

    clientId: text("client_id").notNull(),

    // The HUMAN who approved at the consent screen. This becomes the minted
    // key's `linkedUserId`, which is what makes `agentUserId` defined on the
    // MCP request and therefore routes every Claude write through
    // `checkPermissionOrPropose()`. Losing it silently bypasses governance.
    userId: text("user_id").notNull(),

    // Bound at issue time; /token requires a byte-exact match (RFC 6749 §4.1.3).
    redirectUri: text("redirect_uri").notNull(),

    // Pod-grammar scopes granted by this consent (already intersected with the
    // client's allowlist), copied onto the minted key.
    scopes: text("scopes").array().notNull().default([]),

    // PKCE (RFC 7636). S256 only — `plain` is not accepted anywhere in this
    // flow, so the column always holds the base64url sha256 challenge.
    codeChallenge: text("code_challenge").notNull(),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),

    // Short TTL — /token rejects an expired code.
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),

    // Single-use marker. NULL = unconsumed. Set atomically at /token.
    consumedAt: timestamp("consumed_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (table) => ({
    expiresAtIdx: index("oauth_authorization_codes_expires_at_idx").on(
      table.expiresAt
    ),
  })
);
