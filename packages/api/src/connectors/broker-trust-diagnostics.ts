/**
 * Broker trust diagnostics — WHY a Control-Plane-brokered pod can or cannot
 * broker connections, as non-secret facts.
 *
 * The relay credential reaches the pod through `POST /api/admin/source-configs`,
 * which refuses when the CP issuer is not approved with `source-config:write` or
 * the CP subject has no federated identity link (`admin-source-configs.ts`).
 * Those refusals live only in the CP's log; this read answers the same
 * questions on the pod, from the same tables and the same credential reader the
 * broker uses.
 *
 * NEVER returns key material, tokens or vault refs: presence, status, expiry and
 * the broker's reason enum only. A failed read THROWS — callers answer it as an
 * error, never as a report of absent rows.
 */

import {
  CpRelayVaultUnresolvedError,
  db,
  resolveVaultReferences,
  TRUSTED_ISSUER_CAPABILITIES,
} from "@synap/database";
import { config } from "@synap-core/core";
import { normalizeIssuerUrl } from "../utils/issuer-url-safety.js";
import {
  isControlPlaneBrokered,
  readCpRelayCredential,
  resolveBroker,
} from "./index.js";

/** The display name `seedControlPlaneIssuer` (apps/api startup-hooks) seeds. */
const CP_ISSUER_DISPLAY_NAME = "Synap Control Plane";

export interface BrokerTrustDiagnostics {
  cpIssuer: {
    present: boolean;
    status: "pending" | "approved" | "rejected" | "revoked" | null;
    hasSourceConfigWrite: boolean;
  };
  ownerIdentityLink: { present: boolean };
  /**
   * `resolvable` is true only when the key was read. A seeded row whose vault
   * reference does not resolve is `present` but not `resolvable` — the Control
   * Plane re-delivers it; nothing on the pod restores it.
   */
  relayCredential: {
    present: boolean;
    resolvable: boolean;
    validUntil: string | null;
  };
  broker: {
    kind: "control-plane" | "local";
    reason: string | null;
  };
}

/**
 * @param opts.issuerUrl  The CP issuer as verified from a CP-signed request.
 *   Omitted → the issuer at the canonical `CONTROL_PLANE_URL`, else the
 *   built-in Control Plane issuer seeded at boot (its declared `iss` may differ
 *   from the transport URL).
 * @param opts.issuerSubject  The CP subject a relay delivery would carry. When
 *   known, the link check is exact; otherwise it asks whether a pod owner/admin
 *   holds a link for that issuer.
 */
export async function readBrokerTrustDiagnostics(
  opts: { issuerUrl?: string; issuerSubject?: string } = {}
): Promise<BrokerTrustDiagnostics> {
  const issuer = await findCpIssuer(opts.issuerUrl);

  const ownerLinked = issuer
    ? await hasOwnerIdentityLink(issuer.id, opts.issuerSubject)
    : false;

  // This module's handles, so the credential read is decided by the same
  // `db` (and vault resolver) as every other lookup here. An unresolvable key
  // is a FACT this read reports; every other failure still throws.
  let relayCredential: BrokerTrustDiagnostics["relayCredential"];
  try {
    const credential = await readCpRelayCredential({
      database: db,
      resolveVault: resolveVaultReferences,
    });
    relayCredential = {
      present: !!credential,
      resolvable: !!credential,
      validUntil: credential?.expiresAt?.toISOString() ?? null,
    };
  } catch (err) {
    if (!(err instanceof CpRelayVaultUnresolvedError)) throw err;
    relayCredential = { present: true, resolvable: false, validUntil: null };
  }

  const resolved = await resolveBroker("nango");

  return {
    cpIssuer: {
      present: !!issuer,
      status: issuer?.status ?? null,
      hasSourceConfigWrite:
        !!issuer &&
        issuer.allowedScopes.includes(
          TRUSTED_ISSUER_CAPABILITIES.SOURCE_CONFIG_WRITE
        ),
    },
    ownerIdentityLink: { present: ownerLinked },
    relayCredential,
    broker: {
      kind: isControlPlaneBrokered() ? "control-plane" : "local",
      reason: resolved.ok ? null : resolved.reason,
    },
  };
}

/** Same equality lookup as `TrustedIssuerService.getByUrl`, on this module's `db`. */
async function issuerByUrl(issuerUrl: string) {
  return (
    (await db.query.trustedIssuers.findFirst({
      where: (t, { eq }) => eq(t.issuerUrl, issuerUrl),
    })) ?? null
  );
}

async function findCpIssuer(verifiedIssuerUrl?: string) {
  if (verifiedIssuerUrl) return issuerByUrl(verifiedIssuerUrl);

  const cpUrl = config.server.controlPlaneUrl;
  if (!cpUrl) return null;
  const canonical = normalizeIssuerUrl(cpUrl);
  if (canonical) {
    const exact = await issuerByUrl(canonical);
    if (exact) return exact;
  }
  return (
    (await db.query.trustedIssuers.findFirst({
      where: (t, { and, eq }) =>
        and(eq(t.isBuiltIn, true), eq(t.displayName, CP_ISSUER_DISPLAY_NAME)),
    })) ?? null
  );
}

async function hasOwnerIdentityLink(
  issuerId: string,
  issuerSubject?: string
): Promise<boolean> {
  if (issuerSubject) {
    const link = await db.query.federatedIdentityLinks.findFirst({
      where: (t, { and, eq }) =>
        and(eq(t.issuerId, issuerId), eq(t.issuerSubject, issuerSubject)),
      columns: { userId: true },
    });
    return !!link;
  }

  const podAdminWorkspace = await db.query.workspaces.findFirst({
    where: (t, { eq }) => eq(t.systemSlug, "pod-admin"),
    columns: { id: true },
  });
  if (!podAdminWorkspace) return false;
  const admins = await db.query.workspaceMembers.findMany({
    where: (t, { and, eq, inArray }) =>
      and(
        eq(t.workspaceId, podAdminWorkspace.id),
        inArray(t.role, ["owner", "admin"])
      ),
    columns: { userId: true },
  });
  if (admins.length === 0) return false;
  const link = await db.query.federatedIdentityLinks.findFirst({
    where: (t, { and, eq, inArray }) =>
      and(
        eq(t.issuerId, issuerId),
        inArray(
          t.userId,
          admins.map((a) => a.userId)
        )
      ),
    columns: { userId: true },
  });
  return !!link;
}
