/**
 * The acts-as-person GRANT, read (W3 3c, founder decision 2026-11-09): the
 * light half of `app-acts-as-person.ts` — what the OAuth protocol layer
 * (`loadPersonTokenApp`, `appSignInReach`) and the token mint read on every
 * request, kept free of the proposal and audit graph so the protocol
 * endpoints load nothing more than a table read. The ask, the approval and
 * the revoke live in `app-acts-as-person.ts`.
 */

import { db, eq, type AppActsAsPersonGrant } from "@synap/database";
import { oauthClients, type AppApprovedRequest } from "@synap/database/schema";
import { patternMatches } from "@synap/governance-policy/grants";

import { isSynapApp, type PodAppActsAs } from "../routers/oauth/config.js";

/** How long an approval lasts before the app must ask again (design Q1). */
export const ACTS_AS_PERSON_TTL_DAYS = 90;

/** The connection fields every judgment here reads. */
export interface ActsAsPersonConnection {
  id?: string;
  mode: string;
  oauthClientId: string | null;
  revokedAt?: Date | null;
  removedAt?: Date | null;
  metadata?: Record<string, unknown> | null;
}

export const isPair = (v: unknown): v is AppApprovedRequest =>
  !!v &&
  typeof v === "object" &&
  typeof (v as AppApprovedRequest).permission === "string" &&
  ((v as AppApprovedRequest).workspaceId === null ||
    typeof (v as AppApprovedRequest).workspaceId === "string");

/** The stored grant, when it has the full shape; null otherwise. */
export function readActsAsPersonGrant(
  app: Pick<ActsAsPersonConnection, "metadata">
): AppActsAsPersonGrant | null {
  const raw = (app.metadata ?? {})["actsAsPerson"] as
    Partial<AppActsAsPersonGrant> | undefined;
  if (!raw || typeof raw !== "object") return null;
  if (
    typeof raw.proposalId !== "string" ||
    typeof raw.approvedBy !== "string" ||
    typeof raw.approvedAt !== "string" ||
    typeof raw.expiresAt !== "string" ||
    typeof raw.oauthClientId !== "string" ||
    typeof raw.documentSha256 !== "string" ||
    !Array.isArray(raw.requests) ||
    !raw.requests.every(isPair)
  ) {
    return null;
  }
  return raw as AppActsAsPersonGrant;
}

/**
 * Does this permission let its holder decide proposals (approve or reject)?
 * Matched with the grant matcher the approval door itself uses
 * (`assertMayDecideProposal`), so `*`, `proposal.*` and the review verbs are
 * all caught. Such a pair never acts as the person for an approved app
 * (design Q2): your review stays yours.
 */
export function decidesProposals(permission: string): boolean {
  return (["approve", "reject"] as const).some((action) =>
    patternMatches(permission, { subject: "proposal", action })
  );
}

/** The pairs of an approval that may act as the person: deduped, no review. */
export function actsAsPersonPairs(
  approved: readonly AppApprovedRequest[]
): AppApprovedRequest[] {
  const seen = new Set<string>();
  const out: AppApprovedRequest[] = [];
  for (const r of approved) {
    if (decidesProposals(r.permission)) continue;
    const key = `${r.workspaceId} ${r.permission}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ permission: r.permission, workspaceId: r.workspaceId });
  }
  return out;
}

/** The document hash the pod holds NOW for this client id, or null. */
export async function currentDocumentSha256(
  oauthClientId: string
): Promise<string | null> {
  const [row] = await db
    .select({ sha: oauthClients.metadataSha256 })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, oauthClientId))
    .limit(1);
  return row?.sha ?? null;
}

/**
 * Does an APPROVED grant let this connection act as its person right now?
 * Re-judged every time: a live pod app connection, the same client id, the
 * same document bytes (A4), not expired (A8). Never true for anything but a
 * `mode = 'oauth'` row.
 */
export async function approvedActsAsPersonHolds(
  app: ActsAsPersonConnection,
  now: Date = new Date()
): Promise<boolean> {
  if (app.mode !== "oauth" || !app.oauthClientId) return false;
  if (app.revokedAt || app.removedAt) return false;
  const grant = readActsAsPersonGrant(app);
  if (!grant) return false;
  if (grant.oauthClientId !== app.oauthClientId) return false;
  const expires = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expires) || expires <= now.getTime()) return false;
  const sha = await currentDocumentSha256(app.oauthClientId);
  return sha !== null && sha === grant.documentSha256;
}

/**
 * Who a pod app CONNECTION's token acts as now — the connection-aware twin of
 * `podAppActsAs` (which judges a client id alone): a Synap app, or a
 * connection whose person approved it (`approvedActsAsPersonHolds`), is the
 * person; every other app is its own ask-first agent.
 */
export async function podAppConnectionActsAs(
  app: ActsAsPersonConnection
): Promise<PodAppActsAs> {
  if (app.oauthClientId && isSynapApp(app.oauthClientId)) return "person";
  return (await approvedActsAsPersonHolds(app)) ? "person" : "agent";
}

/**
 * The cap on what an APPROVED (not Synap) connection's person token reaches:
 * `reach` ∩ the frozen pairs, never a pair that decides proposals. A grant
 * widened by a later consent stays at what was approved (A5). Any other app
 * (a Synap app, a registered app) passes unchanged. Pure: whether the grant
 * still HOLDS is `approvedActsAsPersonHolds`, read before any person token is
 * minted or honoured.
 */
export function capToActsAsPersonGrant<
  T extends { permission: string; workspaceId: string | null },
>(app: Partial<ActsAsPersonConnection>, reach: readonly T[]): T[] {
  if (app.mode !== "oauth" || !app.oauthClientId) return [...reach];
  if (isSynapApp(app.oauthClientId)) return [...reach];
  const grant = readActsAsPersonGrant({ metadata: app.metadata ?? null });
  if (!grant) return [];
  const frozen = new Set(
    actsAsPersonPairs(grant.requests).map(
      (r) => `${r.workspaceId} ${r.permission}`
    )
  );
  return reach.filter(
    (r) =>
      !decidesProposals(r.permission) &&
      frozen.has(`${r.workspaceId} ${r.permission}`)
  );
}
