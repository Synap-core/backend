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
 * THREE tables, all pod-local:
 *
 *   oauth_clients              — PUBLIC clients (no secret; PKCE alone
 *                                authenticates the code exchange): RFC 7591
 *                                dynamically-registered ones (claude.ai
 *                                registers per connection) and cached Client
 *                                ID Metadata Documents (pod apps, 0338).
 *   oauth_authorization_codes  — short-lived, single-use authorization codes
 *                                bound to a PKCE challenge.
 *   oauth_refresh_tokens       — rotating, single-use refresh tokens of a
 *                                pod app (0339) or of a Synap app's signed-in
 *                                device (0340); MCP (DCR) clients get none.
 *   person_devices             — a Synap app (desktop, Relay) signed in as a
 *                                person: one per sign-in (0340).
 *   person_device_tokens       — that device's short-lived access tokens
 *                                (0340), sha256 only.
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

import {
  boolean,
  pgTable,
  text,
  timestamp,
  index,
  jsonb,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { apps } from "./apps.js";
import { users } from "./users.js";

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

  // When the pod first saw this client (DCR: registration; CIMD: first fetch).
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),

  // ── Client ID Metadata Documents (0338, spec 17 §6.1) ──────────────────────
  //
  // 'dcr'  — `client_id` = `dcr_<random>`, registered through POST /register.
  // 'cimd' — `client_id` = the https URL of the app's own metadata document;
  //          the row is a CACHE of that document, refreshed by
  //          `routers/oauth/client-metadata.ts`, never written by a client.
  clientKind: text("client_kind")
    .$type<"dcr" | "cimd">()
    .notNull()
    .default("dcr"),
  // Same origin as `client_id`, checked before caching. NULL for DCR rows.
  clientUri: text("client_uri"),
  initiateLoginUri: text("initiate_login_uri"),
  // The grant-grammar permissions the document declares (`synap_requests`).
  requestedPermissions: text("requested_permissions")
    .array()
    .notNull()
    .default([]),
  metadataFetchedAt: timestamp("metadata_fetched_at", {
    mode: "date",
    withTimezone: true,
  }),
  // Fresh until then: the document's Cache-Control, floored 5 min, capped 24 h.
  metadataExpiresAt: timestamp("metadata_expires_at", {
    mode: "date",
    withTimezone: true,
  }),
  metadataSha256: text("metadata_sha256"),
  // The workspace templates the document declares (`synap_templates`, Contract
  // B slugs, 0338b): the consent screen offers to create a space from one when
  // the person has none to give the app. Empty for DCR rows.
  requestedTemplates: text("requested_templates").array().notNull().default([]),
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

    // RFC 8707 resource the authorization was for (`<issuer>/mcp` or
    // `<issuer>/api/hub`), or NULL when the client named none (0338). /token
    // refuses a `resource` that differs from it.
    resource: text("resource"),

    // The approved `apps` row (mode 'oauth') a pod app's code redeems to:
    // /token mints THAT app's key (0338b). NULL for an MCP (DCR) client.
    appId: uuid("app_id").references(() => apps.id, { onDelete: "cascade" }),
    // "Sign in with Synap" (0339): the `[{ permission, workspaceId }]` the
    // person saw and approved for an APP client (`client_id` = `app_…`). /token
    // mints this ∩ the app's approval ∩ the person's reach at mint time, so the
    // token is never wider than the consent. NULL for every other client.
    appGrant:
      jsonb("app_grant").$type<
        Array<{ permission: string; workspaceId: string }>
      >(),

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

    // The consenting session's real `authenticated_at` (0340): a Synap app's
    // device takes it as its step-up clock. NULL when unknown.
    authTime: timestamp("auth_time", { mode: "date", withTimezone: true }),

    // A Synap app's STEP-UP code (`prompt=login`, "Confirm it's you", 0340):
    // it re-confirms a device the app holds and can never make a new one.
    stepUp: boolean("step_up").notNull().default(false),
  },
  (table) => ({
    expiresAtIdx: index("oauth_authorization_codes_expires_at_idx").on(
      table.expiresAt
    ),
  })
);

/**
 * A pod app's refresh tokens (0339, spec 17 §6.6, F5): only sha256(token) is
 * stored, like a code. Each one is SINGLE-USE: redeeming it (`last_used_at`,
 * set atomically) mints a new access key and a successor in the same
 * `family_id`, pointed at by `replaced_by`. A token presented again after its
 * use is a reuse (RFC 9700 §4.14.2): the whole family is revoked, with the
 * connection's live access key. Idle expiry: each token lives 30 d from its
 * issue, so a connection used within every 30 days lives on (no absolute cap).
 *
 * `revoked_at` means KILLED (reuse, /revoke, a newer consent, the app revoked),
 * never "used"; a used token keeps its row until it expires, so a late replay
 * is still recognised as one. Logic: `routers/oauth/refresh.ts` (api).
 *
 * Since 0340 a token belongs to EXACTLY ONE owner (a CHECK): a pod app
 * connection (`app_id`) or a Synap app's signed-in device (`device_id`, whose
 * `id` is also the family id). A device's tokens never outlive its absolute
 * cap (`person_devices.expires_at`).
 */
export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // sha256(rawToken) — the only representation of the token we store.
    tokenHash: text("token_hash").notNull(),
    // Every token rotated from one authorization code shares it.
    familyId: uuid("family_id").notNull(),
    // The pod app (CIMD client_id) it was issued to; /token refuses another.
    clientId: text("client_id").notNull(),
    // The HUMAN whose connection this is (the key's `linkedUserId`).
    userId: text("user_id").notNull(),
    // The connection (`apps` row, mode 'oauth'); deleting it deletes these.
    // NULL exactly when `device_id` is set (0340).
    appId: uuid("app_id").references(() => apps.id, { onDelete: "cascade" }),
    // The signed-in device (0340); NULL for a pod app's token.
    deviceId: uuid("device_id").references((): any => personDevices.id, {
      onDelete: "cascade",
    }),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    // Single-use marker: set when the token was redeemed. NULL = unused.
    lastUsedAt: timestamp("last_used_at", {
      mode: "date",
      withTimezone: true,
    }),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
    // The successor minted when this token was redeemed.
    replacedBy: uuid("replaced_by"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("oauth_refresh_tokens_token_hash_uidx").on(
      table.tokenHash
    ),
    appIdx: index("oauth_refresh_tokens_app_idx").on(table.appId),
    familyIdx: index("oauth_refresh_tokens_family_idx").on(table.familyId),
    deviceIdx: index("oauth_refresh_tokens_device_idx").on(table.deviceId),
  })
);

/**
 * A Synap app signed in as a PERSON (0340): one row per
 * sign-in of a FIRST-PARTY client (`FIRST_PARTY_CLIENTS`, api
 * `routers/oauth/config.ts`). It is the refresh family (`oauth_refresh_tokens`
 * with `device_id` = this id) and the thing the person sees in "Signed-in
 * devices" and revokes. `expires_at` is the absolute cap (180 d): nothing it
 * holds lives past it, however often it refreshes. Revoked = every access and
 * refresh token it holds stops at once (they are read through it).
 * Logic: api `services/person-device-token.ts` (the one mint door) and
 * `@synap/database/person-devices` (lookup, revoke).
 */
export const personDevices = pgTable(
  "person_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The person signed in. Never an agent (the mint door refuses one).
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The first-party client (`synap-desktop`, `synap-relay`).
    clientId: text("client_id").notNull(),
    // What the app calls this device ("MacBook Pro"). App-supplied TEXT.
    label: text("label"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    // Its last refresh (the devices list shows it).
    lastUsedAt: timestamp("last_used_at", {
      mode: "date",
      withTimezone: true,
    }),
    // Absolute cap: created_at + 180 d.
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
    revokedReason: text("revoked_reason"),
    // When the person last really AUTHENTICATED for this device: copied from
    // the consenting Kratos session's `authenticated_at` (via the code), moved
    // only by a step-up (`prompt=login`), never by a refresh. Credential doors
    // accept the device only shortly after it (api utils/device-session.ts).
    authTime: timestamp("auth_time", { mode: "date", withTimezone: true }),
  },
  (table) => ({
    userIdx: index("person_devices_user_idx").on(table.userId),
  })
);

/**
 * A device's ACCESS tokens (0340): sha256(token) only, 1 h, looked up by the
 * hash on every request (no bcrypt). Valid only while the token is unexpired
 * AND its device is neither revoked nor past its cap. Accepted on the app API
 * only (`/trpc`, realtime); never an `api_keys` row, so `/mcp` and Hub REST
 * cannot resolve one.
 */
export const personDeviceTokens = pgTable(
  "person_device_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => personDevices.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("person_device_tokens_token_hash_uidx").on(
      table.tokenHash
    ),
    deviceIdx: index("person_device_tokens_device_idx").on(table.deviceId),
  })
);
