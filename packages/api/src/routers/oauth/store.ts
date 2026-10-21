/**
 * Pod-side storage for the OAuth authorization server.
 *
 * The half of the AS that is NOT protocol: where clients and authorization
 * codes live. Kept separate from `protocol.ts` (pure) and `routes.ts` (HTTP) so
 * the protocol layer stays storage-agnostic.
 *
 * Codes are stored as sha256 hashes only — the same lookup-hash pattern as
 * `api_keys.key_lookup_hash` and `mcp_connect_codes.code_hash`. A database dump
 * therefore contains nothing that can be redeemed.
 */

import { createHash, randomBytes } from "crypto";
import { db, and, eq, isNull, gt } from "@synap/database";
import { oauthClients, oauthAuthorizationCodes } from "@synap/database/schema";

import type { FirstPartyRedirectRule } from "./protocol.js";

/**
 * Authorization-code lifetime. RFC 6749 §4.1.2 recommends a maximum of 10
 * minutes; the code is redeemed by claude.ai within seconds of the redirect, so
 * this is generous already and bounds the replay window.
 */
export const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

export interface StoredClient {
  clientId: string;
  /**
   * 'dcr' — registered at /register; 'cimd' — a cached metadata document;
   * 'app' — an app registered and approved ON THIS POD (`apps`, client_id =
   * its `public_id`), resolved from `apps` and never stored in
   * `oauth_clients` ("Sign in with Synap", `app-client.ts`); 'first_party' —
   * a Synap app (desktop, Relay), declared in code (`FIRST_PARTY_CLIENTS`,
   * config.ts) and never stored.
   */
  clientKind: "dcr" | "cimd" | "app" | "first_party";
  clientName: string;
  redirectUris: string[];
  /**
   * First-party clients only: their redirect RULES (a loopback port is not a
   * list). Every redirect check goes through `clientAcceptsRedirect`.
   */
  firstPartyRedirects?: readonly FirstPartyRedirectRule[] | null;
  scopes: string[];
  /** CIMD only: the grant-grammar permissions the document declares. */
  requestedPermissions: string[];
  /** CIMD only: the workspace-template slugs the document declares (0338b). */
  requestedTemplates?: string[];
  clientUri?: string | null;
  initiateLoginUri?: string | null;
  metadataFetchedAt?: Date | null;
  metadataExpiresAt?: Date | null;
  /** First registration (DCR) or first fetch (CIMD). */
  createdAt: Date;
}

/** A validated metadata document, ready to cache (client-metadata.ts). */
export interface CimdClientInput {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  scopes: string[];
  requestedPermissions: string[];
  requestedTemplates: string[];
  clientUri: string | null;
  initiateLoginUri: string | null;
  metadataFetchedAt: Date;
  metadataExpiresAt: Date;
  metadataSha256: string;
}

export interface IssuedCodeInput {
  clientId: string;
  /**
   * The consenting HUMAN. Copied onto the minted key as `linkedUserId`, which
   * is what makes `agentUserId` defined on an MCP request and routes Claude's
   * writes through `checkPermissionOrPropose()`. Never an agent user.
   */
  userId: string;
  redirectUri: string;
  scopes: string[];
  /** PKCE S256 challenge, already validated by `assertPkceChallenge`. */
  codeChallenge: string;
  /** RFC 8707 resource, canonical (`resourceForIssuer`), or null. */
  resource: string | null;
  /**
   * A pod app's approved `apps` row (mode 'oauth', 0338b): /token mints THAT
   * app's key. Null for an MCP (DCR) client.
   */
  appId?: string | null;
  /**
   * App clients only: the `[{ permission, workspaceId }]` the person saw and
   * approved. /token never mints wider than this. Omitted for other clients.
   */
  appGrant?: AppGrantRequest[] | null;
}

/** One permission in one space — the shape of `apps.approved_requests`. */
export interface AppGrantRequest {
  permission: string;
  workspaceId: string;
}

export interface ClaimedCode {
  clientId: string;
  userId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  resource: string | null;
  appId: string | null;
  /** The consented app grant (app clients), else null. */
  appGrant: AppGrantRequest[] | null;
}

function hashCode(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// ─── Clients ─────────────────────────────────────────────────────────────────

/**
 * Persist a dynamically-registered client and return its generated client_id.
 * The id is server-generated (never client-chosen) so a registration cannot
 * squat or overwrite an existing client's entry.
 */
export async function insertClient(metadata: {
  clientName: string;
  redirectUris: string[];
  scopes: string[];
}): Promise<{ clientId: string; createdAt: Date }> {
  const clientId = `dcr_${randomBytes(16).toString("base64url")}`;
  const createdAt = new Date();
  await db.insert(oauthClients).values({
    clientId,
    clientKind: "dcr",
    clientName: metadata.clientName,
    redirectUris: metadata.redirectUris,
    scopes: metadata.scopes,
    createdAt,
  });
  return { clientId, createdAt };
}

export async function findClient(
  clientId: string
): Promise<StoredClient | null> {
  const row = await db.query.oauthClients.findFirst({
    where: eq(oauthClients.clientId, clientId),
  });
  return row ?? null;
}

/**
 * Cache a validated Client ID Metadata Document. Keyed on the client_id URL:
 * the first fetch inserts (its `created_at` is "first seen"), every refresh
 * overwrites the document fields and keeps `created_at`. Only a 'cimd' row is
 * ever overwritten — a DCR id is `dcr_…` and can never equal a URL, and the
 * `setWhere` makes that a property of the statement rather than of the ids.
 */
export async function upsertCimdClient(
  input: CimdClientInput
): Promise<StoredClient> {
  const fields = {
    clientName: input.clientName,
    redirectUris: input.redirectUris,
    scopes: input.scopes,
    requestedPermissions: input.requestedPermissions,
    requestedTemplates: input.requestedTemplates,
    clientUri: input.clientUri,
    initiateLoginUri: input.initiateLoginUri,
    metadataFetchedAt: input.metadataFetchedAt,
    metadataExpiresAt: input.metadataExpiresAt,
    metadataSha256: input.metadataSha256,
  };
  const [row] = await db
    .insert(oauthClients)
    .values({ clientId: input.clientId, clientKind: "cimd", ...fields })
    .onConflictDoUpdate({
      target: oauthClients.clientId,
      set: fields,
      setWhere: eq(oauthClients.clientKind, "cimd"),
    })
    .returning();
  if (!row) {
    // The conflict row exists but is not a CIMD row: never overwrite it.
    throw new Error("oauth_clients: client_id is taken by a non-CIMD client");
  }
  return row;
}

// ─── Authorization codes ─────────────────────────────────────────────────────

/**
 * Mint an authorization code. Returns the RAW code once — only its sha256 hash
 * is persisted, so this return value is the sole copy that ever exists.
 */
export async function issueAuthorizationCode(
  input: IssuedCodeInput
): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await db.insert(oauthAuthorizationCodes).values({
    codeHash: hashCode(code),
    clientId: input.clientId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    scopes: input.scopes,
    codeChallenge: input.codeChallenge,
    resource: input.resource,
    appId: input.appId ?? null,
    appGrant: input.appGrant ?? null,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
  });
  return code;
}

/**
 * Atomically CLAIM a code: mark it consumed only if it is currently unconsumed
 * AND unexpired, returning the row in the same statement.
 *
 * Doing check-and-consume in ONE `UPDATE … RETURNING` closes the double-redeem
 * race — two concurrent exchanges cannot both win the row, so a code can never
 * mint two access tokens. Claim-BEFORE-verify (the caller checks PKCE and the
 * redirect_uri on the returned row) is the security-correct order for
 * single-use: a failed verification burns the code, which is the desired
 * outcome — a code whose verifier was guessed wrong must not be retryable.
 *
 * Returns null for missing, expired, and already-consumed alike; the caller
 * collapses all three to one generic `invalid_grant` so nothing leaks about
 * which codes exist.
 */
export async function claimAuthorizationCode(
  rawCode: string
): Promise<ClaimedCode | null> {
  const now = new Date();
  const [row] = await db
    .update(oauthAuthorizationCodes)
    .set({ consumedAt: now })
    .where(
      and(
        eq(oauthAuthorizationCodes.codeHash, hashCode(rawCode)),
        isNull(oauthAuthorizationCodes.consumedAt),
        gt(oauthAuthorizationCodes.expiresAt, now)
      )
    )
    .returning({
      clientId: oauthAuthorizationCodes.clientId,
      userId: oauthAuthorizationCodes.userId,
      redirectUri: oauthAuthorizationCodes.redirectUri,
      scopes: oauthAuthorizationCodes.scopes,
      codeChallenge: oauthAuthorizationCodes.codeChallenge,
      resource: oauthAuthorizationCodes.resource,
      appId: oauthAuthorizationCodes.appId,
      appGrant: oauthAuthorizationCodes.appGrant,
    });
  return row ? { ...row, appGrant: row.appGrant ?? null } : null;
}
