/**
 * The pod's Control Plane relay credential — the CP-issued ES256 JWT
 * (`type:"pod_relay"`, `podId` claim) the CP verifies on every pod→CP call
 * (connector broker, tool-demand forwarding).
 *
 * THE ONE READER. It lives in @synap/database because @synap/jobs cannot import
 * @synap/api (api → jobs) and a pod→CP job needs the same resolution the api
 * broker uses. `packages/api/src/connectors/index.ts` re-exports it under the
 * same names.
 */

import { db } from "../index.js";
import { resolveVaultReferences } from "./vault-resolver.js";

/**
 * The name the Control Plane seeds its relay credential under — mirrored from
 * the CP's `seedRelaySourceConfig` (synap-control-plane-api
 * services/provisioning/source-config-seed.ts). A `cp-relay` config an admin
 * creates under any other name is never read as the broker credential.
 */
export const CP_RELAY_SOURCE_NAME = "Synap Relay (CP-managed)";

/** How many recent seeded relay rows are considered when picking the live key. */
const RELAY_ROW_CANDIDATES = 5;

/** The `exp` of a JWT, unverified, or null when it cannot be read. */
export function relayKeyExpiry(jwt: string): Date | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const exp = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    )?.exp;
    return typeof exp === "number" ? new Date(exp * 1000) : null;
  } catch {
    return null;
  }
}

/**
 * What the reader reads through. Defaults to this package's own `db` and vault
 * resolver; a caller that holds its own handles (the api barrel's `db`, which
 * its seam tests swap) passes them, so ONE reader stays testable from outside
 * this package's dist.
 */
export interface CpRelayCredentialDeps {
  database?: Pick<typeof db, "query">;
  resolveVault?: typeof resolveVaultReferences;
}

/**
 * The pod's CP relay credential: `CP_RELAY_KEY` / `SOURCE_RELAY_KEY`, else the
 * longest-lived key among the most recent SEEDED `cp-relay` rows. `null` when
 * none exists; THROWS when the rows or vault cannot be read, so a failed read is
 * never reported as an absent credential. The key never leaves the pod — only
 * the broker client and a non-secret status read it.
 */
export async function readCpRelayCredential(
  deps: CpRelayCredentialDeps = {}
): Promise<{
  key: string;
  expiresAt: Date | null;
} | null> {
  const database = deps.database ?? db;
  const resolveVault = deps.resolveVault ?? resolveVaultReferences;
  const envKey = process.env.CP_RELAY_KEY || process.env.SOURCE_RELAY_KEY;
  if (envKey) return { key: envKey, expiresAt: relayKeyExpiry(envKey) };

  // The CP rotates by delivering a fresh seeded row through a create-only
  // door. Of the most recent SEEDED rows, take the key that lives longest.
  const rows = await database.query.sourceConfigs.findMany({
    where: (t, { and, eq }) =>
      and(
        eq(t.providerType, "cp-relay"),
        eq(t.name, CP_RELAY_SOURCE_NAME),
        eq(t.enabled, true)
      ),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: RELAY_ROW_CANDIDATES,
    columns: { config: true, userId: true },
  });
  let best: { key: string; exp: number } | null = null;
  let unresolvedRows = 0;
  for (const row of rows) {
    const ref = (row.config as Record<string, unknown> | undefined)?.relayKey;
    if (typeof ref !== "string") continue;
    const resolved = await resolveVault({ relayKey: ref }, row.userId);
    const key = resolved.relayKey;
    // `resolveVaultReferences` maps an unresolvable vault (server key unset,
    // secret row missing) to "" — a FAULT, not an absent credential.
    if (!key) {
      unresolvedRows += 1;
      continue;
    }
    const exp = relayKeyExpiry(key)?.getTime() ?? 0;
    if (!best || exp > best.exp) best = { key, exp };
  }
  if (best) return { key: best.key, expiresAt: relayKeyExpiry(best.key) };
  // A seeded row exists but none of them resolved: a broken vault must never
  // read as "no credential". Lenient when ANY row resolved (a stale broken row
  // next to a live key does not take the pod down).
  if (unresolvedRows > 0) throw new CpRelayVaultUnresolvedError(unresolvedRows);
  return null;
}

/**
 * A seeded relay row is present but its vault reference did not resolve (the
 * vault is unavailable or the secret is missing). Distinct from "no credential"
 * (`null`) and from a failed row read (the underlying error).
 */
export class CpRelayVaultUnresolvedError extends Error {
  readonly code = "vault-unresolved" as const;
  constructor(readonly unresolvedRows: number) {
    super("relay row present, vault reference unresolved");
    this.name = "CpRelayVaultUnresolvedError";
  }
}
