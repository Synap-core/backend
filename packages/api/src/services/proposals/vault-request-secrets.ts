/**
 * Which of a person's vault secrets a `vault.request` can grant — ONE read for
 * the approve executor (`routers/proposals/executors/vault.ts`) and for the
 * request's setup row (`repair-setup.ts`), so "no secret matches" is decided
 * once: the row the person fills appears exactly when the approval would
 * refuse.
 *
 * Candidates are the approver's OWN server-encrypted, not-deleted secrets
 * (only the owner may grant one); the match is the shared rule
 * (`matchVaultRequestSecrets`, the desktop vault card's).
 */
import { db, and, eq, isNull } from "@synap/database";
import { secrets } from "@synap/database/schema";
import { matchVaultRequestSecrets } from "@synap-core/types/vault";

export interface VaultRequestCandidate {
  id: string;
  type: string;
  name: string;
  category: string | null;
  url: string | null;
  description: string | null;
}

/** The approver's own secrets a request may be granted from. */
export async function listRequestableSecrets(
  approverId: string
): Promise<VaultRequestCandidate[]> {
  const rows = await db.query.secrets.findMany({
    where: and(
      eq(secrets.userId, approverId),
      isNull(secrets.deletedAt),
      eq(secrets.encryptionMode, "server")
    ),
    columns: {
      id: true,
      type: true,
      name: true,
      category: true,
      url: true,
      description: true,
    },
  });
  return rows;
}

/** The request's own fields: at the top of `data`, or a wrapped `data.data`. */
export function vaultRequestFields(data: unknown): Record<string, unknown> {
  const raw = (data ?? {}) as Record<string, unknown>;
  const inner = raw.data;
  return inner && typeof inner === "object" && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : raw;
}

/** The candidates the shared rule matches for this request. */
export function matchRequestedSecrets(
  owned: readonly VaultRequestCandidate[],
  fields: Record<string, unknown>
): VaultRequestCandidate[] {
  return matchVaultRequestSecrets(owned, {
    service: typeof fields.service === "string" ? fields.service : "",
    secretType:
      typeof fields.secretType === "string" ? fields.secretType : null,
  });
}
