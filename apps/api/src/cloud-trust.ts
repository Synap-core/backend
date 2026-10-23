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
  const db = await getDb();
  const [row] = await db
    .select({ settings: podSettings.settings })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  const value = (
    row?.settings as { accountRecovery?: { cloudTrust?: unknown } } | undefined
  )?.accountRecovery?.cloudTrust;
  return isCloudTrustMode(value) ? value : DEFAULT_CLOUD_TRUST;
}
