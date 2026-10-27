/**
 * The pod's ONE Unipile connection: the installed `unipile-linkedin` capability.
 *
 * Unipile v2 has no per-account DSN (one global host, an `X-API-KEY`), so the
 * messaging service needs nothing the capability does not already hold: its
 * tools carry the vaulted v2 key as `vault://<secretId>`. The messaging
 * connector reads THAT secret — the same one `unipile_list_accounts` and the
 * other verbs send — so there is no second setup to drift from the first.
 *
 * Absent and broken are different answers: `not-installed` / `no-key` are the
 * honest "not set up" (409 MESSAGING_NOT_CONFIGURED); `unreadable` is a fault
 * on a key that exists, and is reported as one.
 */

import { db, and, eq, asc, desc, isNull, drizzleSql } from "@synap/database";
import { decryptServerSide } from "@synap/database";
import { capabilities, links, secrets, tools } from "@synap/database/schema";
import { vaultSecretIdOf } from "@synap-core/types/vault";

/** `CapabilityDefinition.key` of the Unipile capability (catalog + CP). */
export const UNIPILE_CAPABILITY_KEY = "unipile-linkedin";

/** Unipile API v2: one global host, no DSN. */
export const UNIPILE_V2_BASE_URL = "https://api.unipile.com/v2";

/** What a person reads when the pod has no usable Unipile connection. */
export const UNIPILE_NOT_CONFIGURED_MESSAGE =
  'No messaging service is set up on this pod. Install the "Unipile — Messaging & LinkedIn" capability and connect your Unipile v2 API key.';

export type UnipileConnectionProblem =
  "not-installed" | "no-key" | "unreadable";

export type UnipileConnection =
  | { ok: true; apiKey: string; capabilityId: string; secretId: string }
  | {
      ok: false;
      problem: UnipileConnectionProblem;
      capabilityId: string | null;
      error: string;
    };

/**
 * Resolve the key the installed Unipile capability's tools use. Never throws
 * for a missing or unreadable key: the result says which.
 */
export async function resolveUnipileConnection(): Promise<UnipileConnection> {
  // A pod-wide install first, then the oldest; one connection serves the pod.
  const [cap] = await db
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(eq(capabilities.templateKey, UNIPILE_CAPABILITY_KEY))
    .orderBy(
      desc(drizzleSql`(${capabilities.workspaceId} IS NULL)`),
      asc(capabilities.createdAt)
    )
    .limit(1);
  if (!cap) {
    return {
      ok: false,
      problem: "not-installed",
      capabilityId: null,
      error: UNIPILE_NOT_CONFIGURED_MESSAGE,
    };
  }

  const members = await db
    .select({ credentialRef: tools.credentialRef })
    .from(links)
    .innerJoin(tools, drizzleSql`${tools.id}::text = ${links.fromId}`)
    .where(
      and(
        eq(links.fromType, "tool"),
        eq(links.linkType, "member_of"),
        eq(links.toType, "capability"),
        eq(links.toId, cap.id)
      )
    );
  const secretIds = [
    ...new Set(
      members
        .map((m) => vaultSecretIdOf(m.credentialRef))
        .filter((id): id is string => !!id)
    ),
  ];
  if (secretIds.length === 0) {
    return {
      ok: false,
      problem: "no-key",
      capabilityId: cap.id,
      error:
        "The Unipile capability is installed but its tool has no API key. Connect your Unipile v2 API key on the capability.",
    };
  }
  if (secretIds.length > 1) {
    return {
      ok: false,
      problem: "unreadable",
      capabilityId: cap.id,
      error: `The Unipile capability's tools use ${secretIds.length} different keys; the messaging service cannot tell which one to use.`,
    };
  }

  const secretId = secretIds[0]!;
  const [row] = await db
    .select({
      id: secrets.id,
      encryptedData: secrets.encryptedData,
      iv: secrets.iv,
      authTag: secrets.authTag,
      encryptionMode: secrets.encryptionMode,
    })
    .from(secrets)
    .where(and(eq(secrets.id, secretId), isNull(secrets.deletedAt)))
    .limit(1);
  if (!row) {
    return {
      ok: false,
      problem: "no-key",
      capabilityId: cap.id,
      error:
        "The Unipile capability's API key was deleted. Connect your Unipile v2 API key on the capability again.",
    };
  }
  if (row.encryptionMode !== "server") {
    return {
      ok: false,
      problem: "unreadable",
      capabilityId: cap.id,
      error:
        "The Unipile API key is encrypted on your device, so the pod cannot use it for messaging. Store it again from the capability.",
    };
  }
  try {
    const apiKey = decryptServerSide(
      {
        encryptedData: row.encryptedData!,
        iv: row.iv!,
        authTag: row.authTag!,
      },
      { column: "secrets.encrypted_data", rowId: row.id }
    );
    return { ok: true, apiKey, capabilityId: cap.id, secretId };
  } catch (err) {
    return {
      ok: false,
      problem: "unreadable",
      capabilityId: cap.id,
      error: `The Unipile API key could not be decrypted: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** The messaging service's connection state, as the settings screens read it. */
export interface MessagingServiceState {
  configured: boolean;
  capabilityKey: string;
  capabilityId: string | null;
  problem: UnipileConnectionProblem | null;
  message: string | null;
}

export async function describeMessagingService(): Promise<MessagingServiceState> {
  const conn = await resolveUnipileConnection();
  return conn.ok
    ? {
        configured: true,
        capabilityKey: UNIPILE_CAPABILITY_KEY,
        capabilityId: conn.capabilityId,
        problem: null,
        message: null,
      }
    : {
        configured: false,
        capabilityKey: UNIPILE_CAPABILITY_KEY,
        capabilityId: conn.capabilityId,
        problem: conn.problem,
        message: conn.error,
      };
}
