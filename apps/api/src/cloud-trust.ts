/**
 * The owner's Synap Cloud trust (`pod_settings.settings.accountRecovery.
 * cloudTrust`): the ONE reader. `off` is the pod-wide "Allow sign-in with
 * Synap Cloud" switch turned off (ADDENDUM 2026-10-23). Read by the
 * account-recovery routes, the Kratos hooks (registration gate, login, settings
 * guard) and sign-in discovery, so they can never disagree. Its own module so
 * a reader does not pull the account-recovery dependencies in. A failed read
 * THROWS; an absent or unknown value is the default.
 */
import { getDb } from "@synap/database";
import { podSettings } from "@synap/database/schema";
import {
  DEFAULT_CLOUD_TRUST,
  isCloudTrustMode,
  type CloudTrustMode,
} from "@synap-core/types/account-recovery";

export async function readCloudTrust(): Promise<CloudTrustMode> {
  return (await readCloudSignInSettings()).trust;
}

/**
 * The Cloud trust and the pod's Synap Cloud issuer (the CP-pushed
 * `federationOidcClient.issuer`), from ONE read of the settings row: a door
 * that takes a Synap Cloud assertion (the identity-link ceremony) refuses it
 * when the owner turned Synap Cloud off. A failed read THROWS.
 */
export async function readCloudSignInSettings(): Promise<{
  trust: CloudTrustMode;
  federationIssuer: string | null;
}> {
  const db = await getDb();
  const [row] = await db
    .select({ settings: podSettings.settings })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  const settings = row?.settings as
    | {
        accountRecovery?: { cloudTrust?: unknown };
        federationOidcClient?: { issuer?: unknown };
      }
    | undefined;
  const value = settings?.accountRecovery?.cloudTrust;
  const issuer = settings?.federationOidcClient?.issuer;
  return {
    trust: isCloudTrustMode(value) ? value : DEFAULT_CLOUD_TRUST,
    federationIssuer:
      typeof issuer === "string" && issuer.trim() ? issuer : null,
  };
}
