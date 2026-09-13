/**
 * Broker trust — the pod's non-secret answer to "why can this pod not reach its
 * connection broker?", read through `trustedIssuers.brokerDiagnostics` (the same
 * reader as `GET /api/hub/connectors/broker-diagnostics`).
 *
 * Read over raw tRPC HTTP, not the typed client: `@synap-core/api-types` is a
 * committed generated artifact regenerated at release (see `lib/pod-trpc.ts`),
 * so a new procedure is invisible to the typed client until then.
 */

/** Query key shared by the panel and anything that changes issuer trust. */
export const BROKER_TRUST_QUERY_KEY = ["pod-admin", "broker-trust"] as const;

export interface BrokerTrustReport {
  cpIssuer: {
    present: boolean;
    status: "pending" | "approved" | "rejected" | "revoked" | null;
    hasSourceConfigWrite: boolean;
  };
  ownerIdentityLink: { present: boolean };
  relayCredential: { present: boolean; validUntil: string | null };
  broker: { kind: "control-plane" | "local"; reason: string | null };
}

/** The first blocking fact, in the order a relay-key delivery is checked. */
export type BrokerTrustState =
  | { kind: "not-managed" }
  | { kind: "ok"; validUntil: string | null }
  | { kind: "issuer-missing" }
  | { kind: "issuer-pending" }
  | { kind: "issuer-closed"; status: "rejected" | "revoked" }
  | { kind: "issuer-scope-missing" }
  | { kind: "owner-link-missing" }
  | { kind: "credential-missing" }
  | { kind: "credential-expired"; validUntil: string }
  | { kind: "broker-fault"; reason: string };

export function deriveBrokerTrustState(
  r: BrokerTrustReport,
  now: number = Date.now()
): BrokerTrustState {
  if (r.broker.kind !== "control-plane") return { kind: "not-managed" };
  if (!r.cpIssuer.present) return { kind: "issuer-missing" };
  if (r.cpIssuer.status === "rejected" || r.cpIssuer.status === "revoked") {
    return { kind: "issuer-closed", status: r.cpIssuer.status };
  }
  if (r.cpIssuer.status !== "approved") return { kind: "issuer-pending" };
  if (!r.cpIssuer.hasSourceConfigWrite) return { kind: "issuer-scope-missing" };
  if (!r.ownerIdentityLink.present) return { kind: "owner-link-missing" };
  if (!r.relayCredential.present) return { kind: "credential-missing" };
  const validUntil = r.relayCredential.validUntil;
  if (validUntil && Date.parse(validUntil) <= now) {
    return { kind: "credential-expired", validUntil };
  }
  if (r.broker.reason) return { kind: "broker-fault", reason: r.broker.reason };
  return { kind: "ok", validUntil };
}

/**
 * Unwrap a tRPC (SuperJSON) query response. A failure or an empty result is
 * returned as an error — never as a report of absent rows.
 */
export function readBrokerTrustEnvelope(
  status: number,
  body: unknown
): { ok: true; report: BrokerTrustReport } | { ok: false; message: string } {
  const envelope = body as {
    result?: { data?: { json?: unknown } };
    error?: { json?: { message?: string } };
  } | null;
  if (envelope?.error) {
    return {
      ok: false,
      message: envelope.error.json?.message ?? `Pod returned ${status}.`,
    };
  }
  const report = envelope?.result?.data?.json as BrokerTrustReport | undefined;
  if (
    status < 200 ||
    status >= 300 ||
    !report ||
    typeof report.cpIssuer?.present !== "boolean" ||
    typeof report.ownerIdentityLink?.present !== "boolean" ||
    typeof report.relayCredential?.present !== "boolean" ||
    typeof report.broker?.kind !== "string"
  ) {
    return {
      ok: false,
      message: `The pod returned no readable diagnostics (${status}).`,
    };
  }
  return { ok: true, report };
}

/** Throws on any failure so the query lands in its error state. */
export async function fetchBrokerTrust(
  podUrl: string
): Promise<BrokerTrustReport> {
  const res = await fetch(`${podUrl}/trpc/trustedIssuers.brokerDiagnostics`, {
    credentials: "include",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  const read = readBrokerTrustEnvelope(res.status, body);
  if (!read.ok) throw new Error(read.message);
  return read.report;
}
