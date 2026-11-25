/**
 * The person's OWN vault secrets they can hand to an agent — ONE floor for
 * the provide sheet (`focus-sessions/provide-options.ts`) and a proposal's
 * setup rows (`proposals/repair-setup.ts`): theirs, not deleted,
 * server-encrypted (a legacy client row cannot be read by the pod), and not a
 * connection pointer (those are handed over as connections).
 *
 * A pick is checked by id under the same floor ({@link isOwnHandableSecret}),
 * never by membership in a listed page: a list may be capped for display, a
 * valid pick must never be refused for sitting past the cap (review a089b624
 * S7).
 *
 * Not the `vault.request` floor (`proposals/vault-request-secrets.ts`), which
 * keeps connection pointers: the approve executor may grant one.
 */
import { db, and, asc, eq, isNull } from "@synap/database";
import { secrets } from "@synap/database/schema";

export interface OwnHandableSecret {
  id: string;
  name: string;
  type: string;
  category: string | null;
}

function ownHandableWhere(userId: string) {
  return and(
    eq(secrets.userId, userId),
    isNull(secrets.deletedAt),
    isNull(secrets.capabilityId),
    eq(secrets.encryptionMode, "server")
  );
}

/** The person's handable secrets, by name; `limit` caps a display list only. */
export async function listOwnHandableSecrets(
  userId: string,
  opts?: { limit?: number }
): Promise<OwnHandableSecret[]> {
  const query = db
    .select({
      id: secrets.id,
      name: secrets.name,
      type: secrets.type,
      category: secrets.category,
    })
    .from(secrets)
    .where(ownHandableWhere(userId))
    .orderBy(asc(secrets.name));
  return opts?.limit !== undefined ? query.limit(opts.limit) : query;
}

/** Is this secret one the person may hand over? Owner-floored, by id. */
export async function isOwnHandableSecret(
  userId: string,
  secretId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(and(eq(secrets.id, secretId), ownHandableWhere(userId)))
    .limit(1);
  return !!row;
}
