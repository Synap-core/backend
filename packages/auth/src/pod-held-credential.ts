/**
 * Does a Kratos identity hold a POD-HELD way in — a password or a passkey —
 * as opposed to signing in only through Synap Cloud (`oidc`)? One reader for
 * account recovery (apps/api `account-recovery-deps.ts`) and the unlink
 * confirm (@synap/api `unlinkImpacts`), so the two can never disagree.
 */

const kratosAdminUrl = () =>
  (process.env.KRATOS_ADMIN_URL || "http://localhost:4434").replace(/\/$/, "");

const KRATOS_TIMEOUT_MS = 8_000;

/** Kratos identity credential types that are a pod-held way in. */
const POD_HELD_CREDENTIAL_TYPES = new Set(["password", "passkey", "webauthn"]);

/**
 * From a Kratos admin `GET /admin/identities/{id}` body: does the identity
 * hold a pod-held credential? (`credentials` is a map keyed by type.)
 */
export function identityHasPodHeldCredential(identity: unknown): boolean {
  const creds = (identity as { credentials?: Record<string, unknown> } | null)
    ?.credentials;
  if (!creds || typeof creds !== "object") return false;
  return Object.keys(creds).some((type) => POD_HELD_CREDENTIAL_TYPES.has(type));
}

/** Kratos admin identity read → does it hold a password / passkey? Throws on a failed read. */
export async function kratosIdentityHasPodHeldCredential(
  identityId: string
): Promise<boolean> {
  const res = await fetch(
    `${kratosAdminUrl()}/admin/identities/${encodeURIComponent(identityId)}`,
    { signal: AbortSignal.timeout(KRATOS_TIMEOUT_MS) }
  );
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Kratos identity read failed: ${res.status}`);
  return identityHasPodHeldCredential(await res.json());
}
