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

/**
 * Authorization-code lifetime. RFC 6749 §4.1.2 recommends a maximum of 10
 * minutes; the code is redeemed by claude.ai within seconds of the redirect, so
 * this is generous already and bounds the replay window.
 */
export const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

export interface StoredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  scopes: string[];
  createdAt: Date;
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
}

export interface ClaimedCode {
  clientId: string;
  userId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
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
    });
  return row ?? null;
}
