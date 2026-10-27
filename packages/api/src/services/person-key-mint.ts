/**
 * The ONE mint of a person's own key: `apiKeys.create` calls it after its
 * gate, and a CLI key request calls it when the CLI collects the key the
 * person approved (keys plan Decision 4: "the approval calls the one mint
 * function that apiKeys.create uses").
 *
 * The caller has already decided: validated the grant, derived the scopes from
 * the uses (`deriveKeyScopes`) and passed the governance gate as the person.
 * This writes the key (bcrypt + lookup hash, `ApiKeyRepository`), attaches its
 * grant (revoking the key if that fails), and records the audit line and side
 * effects. The plaintext is returned to the caller ONCE and never stored.
 */

import { randomBytes } from "crypto";
import { ApiKeyRepository, EventRepository, getDb, sql } from "@synap/database";
import { resolveKeyExpiry } from "@synap/governance-policy/grants";
import { emitSideEffects } from "@synap/events";
import { auditLog } from "../utils/audit-log.js";
import { attachGrantOrRevoke, type GrantInput } from "./key-grant.js";

export interface MintPersonKeyInput {
  /** The person who owns the key and acts in minting it. */
  personUserId: string;
  keyName: string;
  scope: string[];
  hubId?: string;
  /** Omitted → 90 days; a number → that many; null → never. */
  expiresInDays?: number | null;
  grant: GrantInput;
  /** "Where you kept it" — stored as the key's description. */
  note?: string;
  /** The space the mint is made in (audit and side effects only). */
  workspaceId?: string;
  /** Extra audit fields (the key request it answers). */
  auditData?: Record<string, unknown>;
}

export interface MintedPersonKey {
  id: string;
  /** The plaintext, returned ONCE. */
  key: string;
  keyPrefix: string;
  expiresAt: Date | null;
}

export function generateApiKey(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("hex")}`;
}

export async function mintPersonKey(
  input: MintPersonKeyInput
): Promise<MintedPersonKey> {
  const keyPrefix = input.hubId
    ? process.env.NODE_ENV === "production"
      ? "synap_hub_live_"
      : "synap_hub_test_"
    : "synap_user_";
  const key = generateApiKey(keyPrefix);
  const expiresAt = resolveKeyExpiry(input.expiresInDays);

  const database = await getDb();
  const apiKeyRepo = new ApiKeyRepository(database, new EventRepository(sql));
  const apiKey = await apiKeyRepo.create(
    {
      keyName: input.keyName,
      keyPrefix,
      key,
      hubId: input.hubId,
      scope: input.scope,
      expiresAt: expiresAt ?? undefined,
      userId: input.personUserId,
      keyType: input.hubId ? "hub_inbound" : "user_pat",
      ...(input.note ? { description: input.note } : {}),
    },
    input.personUserId
  );

  await attachGrantOrRevoke({
    apiKeyId: apiKey.id,
    principalUserId: input.personUserId,
    onBehalfOf: input.personUserId,
    grant: input.grant,
    expiresAt,
    createdBy: input.personUserId,
  });

  auditLog({
    subjectType: "apiKey",
    action: "create",
    phase: "completed",
    subjectId: apiKey.id,
    userId: input.personUserId,
    workspaceId: input.workspaceId,
    data: { keyName: input.keyName, keyPrefix, ...(input.auditData ?? {}) },
  });

  emitSideEffects({
    subjectType: "apiKey",
    action: "create",
    subjectId: apiKey.id,
    userId: input.personUserId,
    workspaceId: input.workspaceId,
  });

  return { id: apiKey.id, key, keyPrefix, expiresAt };
}
