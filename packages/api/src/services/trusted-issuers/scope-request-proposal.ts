/**
 * D7 — the OWNER's consent to a wider trusted-issuer grant, as a proposal.
 *
 * The pod grants the Control Plane only the release-pinned scopes
 * (`CONTROL_PLANE_ISSUER_SCOPES`); a scope the CP declares beyond them is
 * stored as a PENDING request on its `trusted_issuers` row (`seedBuiltIn`).
 * Nobody saw that request: no surface shows trusted issuers. This module turns
 * it into ONE pending proposal in the pod owner's review queue, filed through
 * the pending-proposal door (`insertPendingProposal`), and keeps the queue in
 * step with the row on every boot:
 *
 *   - an OPEN proposal for the current ask         → nothing (idempotent)
 *   - a REJECTED proposal for the current ask      → the row records the NO
 *     (`declineRequestedScopes`); nothing is re-filed until the ask changes
 *   - an open proposal for an ask that is gone     → WITHDRAWN (the issuer
 *     changed or dropped its ask, or the owner granted it another way)
 *   - otherwise                                     → file one proposal
 *
 * Rejection is reconciled HERE, from the proposals table, rather than in the
 * reject doors: every door that can reject (`reject`, `batchReject`, and the
 * MCP / Hub doors that delegate to them) leaves the same REJECTED row, so the
 * decision is read where it is durable instead of hooked into each door.
 *
 * The approval half is `routers/proposals/executors/trusted-issuer.ts`.
 * Governance: the event key is a HUMAN GATE (`@synap/governance-policy`) — no
 * rule, list or ownership rung can auto-approve it — and approval is
 * pod-admin-only (`governanceApprovalFloorFor`).
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  inArray,
  proposals,
  ProposalStatus,
  insertPendingProposal,
  TrustedIssuerService,
  getPendingScopes,
  getDeclinedScopes,
  sameScopeSet,
  drizzleSql,
  type TrustedIssuer,
} from "@synap/database";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import { resolvePodOwnerUserId } from "../capabilities/pod-owner.js";
import { notifyProposalCreatedOrdered } from "../../notifications/notify-proposal-created-ordered.js";
import { discardProposalSourceBlob } from "../../utils/store-entity-source-blob.js";
import { markProposalNotificationsActioned } from "../../notifications/mark-proposal-notifications-actioned.js";
import {
  TRUSTED_ISSUER_TARGET_TYPE,
  TRUSTED_ISSUER_WIDEN_SCOPES_PROPOSAL_TYPE,
} from "./widen-scopes-type.js";

const logger = createLogger({ module: "trusted-issuer-scope-request" });

export {
  TRUSTED_ISSUER_TARGET_TYPE,
  TRUSTED_ISSUER_WIDEN_SCOPES_PROPOSAL_TYPE,
};

/**
 * The stored payload. `name` / `url` / `description` are the keys every
 * review card already renders for an unknown kind (`VISIBLE_TOPLEVEL_BASE`),
 * so the request reads without a dedicated card; the scope arrays are the
 * machine-exact ask the approval grants.
 */
export interface TrustedIssuerWidenScopesData {
  source: "system";
  summary: string;
  description: string;
  name: string;
  url: string;
  issuerId: string;
  issuerUrl: string;
  /** What the issuer holds today. */
  grantedScopes: string[];
  /** What approving adds — exactly the row's pending request when filed. */
  requestedScopes: string[];
}

export type ScopeRequestSyncOutcome =
  | { action: "none" }
  | { action: "unchanged"; proposalId: string }
  | { action: "declined"; proposalId: string }
  | { action: "filed"; proposalId: string }
  | { action: "no_owner" };

/** The scope set a stored proposal asks for (empty on a malformed row). */
export function proposalRequestedScopes(data: unknown): string[] {
  const scopes = (data as { requestedScopes?: unknown } | null)
    ?.requestedScopes;
  return Array.isArray(scopes)
    ? scopes.filter((s): s is string => typeof s === "string")
    : [];
}

function buildWidenScopesData(
  issuer: TrustedIssuer,
  requested: string[]
): TrustedIssuerWidenScopesData {
  const name = issuer.displayName;
  return {
    source: "system",
    summary: buildObjectActionTitle({
      action: TRUSTED_ISSUER_WIDEN_SCOPES_PROPOSAL_TYPE,
      objectKind: TRUSTED_ISSUER_TARGET_TYPE,
      objectName: name,
    }),
    description:
      `${name} asks for more access to this pod: ${requested.join(", ")}. ` +
      `It already has: ${issuer.allowedScopes.join(", ") || "nothing"}. ` +
      `Approving grants exactly the scopes asked for; rejecting keeps the ` +
      `current access and is not asked again until the request changes.`,
    name,
    url: issuer.issuerUrl,
    issuerId: issuer.id,
    issuerUrl: issuer.issuerUrl,
    grantedScopes: [...issuer.allowedScopes].sort(),
    requestedScopes: [...requested].sort(),
  };
}

/**
 * Bring the owner's review queue in step with one issuer's pending scope
 * request. Safe on every boot: one advisory-locked transaction per issuer, so
 * two API processes booting together still file at most one proposal.
 */
export async function syncTrustedIssuerScopeRequest(
  issuerUrl: string,
  deps: { resolveOwner?: () => Promise<string | null> } = {}
): Promise<ScopeRequestSyncOutcome> {
  const svc = new TrustedIssuerService(db);
  const issuer = await svc.getByUrl(issuerUrl);
  if (!issuer) return { action: "none" };
  const pending = getPendingScopes(issuer);
  const declined = getDeclinedScopes(issuer);

  const filed = await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`select pg_advisory_xact_lock(hashtext(${`${TRUSTED_ISSUER_WIDEN_SCOPES_PROPOSAL_TYPE}:${issuer.id}`}))`
    );
    const rows = await tx
      .select({
        id: proposals.id,
        status: proposals.status,
        data: proposals.data,
      })
      .from(proposals)
      .where(
        and(
          eq(proposals.targetType, TRUSTED_ISSUER_TARGET_TYPE),
          eq(proposals.proposalType, TRUSTED_ISSUER_WIDEN_SCOPES_PROPOSAL_TYPE),
          eq(proposals.targetId, issuer.id),
          inArray(proposals.status, [
            ProposalStatus.PENDING,
            ProposalStatus.REJECTED,
          ])
        )
      );
    const open = rows.filter((r) => r.status === ProposalStatus.PENDING);
    const matches = (r: { data: unknown }, set: string[]) =>
      set.length > 0 && sameScopeSet(proposalRequestedScopes(r.data), set);

    // An open proposal is CURRENT when it asks for the pending set, or for
    // the declined set (a rejected proposal the owner reopened). Every other
    // open proposal asks for something the issuer no longer asks for.
    const stale = open.filter(
      (r) => !matches(r, pending) && !matches(r, declined)
    );
    if (stale.length > 0) {
      const ids = stale.map((r) => r.id);
      const withdrawn = await tx
        .update(proposals)
        .set({
          status: ProposalStatus.WITHDRAWN,
          updatedAt: new Date(),
          data: drizzleSql`COALESCE(${proposals.data}, '{}'::jsonb) || '{"withdrawnReason":"scope_request_changed"}'::jsonb`,
        })
        .where(
          and(
            inArray(proposals.id, ids),
            eq(proposals.status, ProposalStatus.PENDING)
          )
        )
        .returning({ id: proposals.id, data: proposals.data });
      markProposalNotificationsActioned(ids);
      // WITHDRAWN is terminal: the same discard every terminal door makes. A
      // no-op for a scope request (it stages no source blob); `null` because,
      // like the expiry scanners, the boot sync acts as no user.
      for (const row of withdrawn) {
        await discardProposalSourceBlob({
          database: db,
          userId: null,
          proposalData: row.data,
        });
      }
    }

    if (pending.length === 0) return null;
    const current = open.find((r) => matches(r, pending));
    if (current)
      return { action: "unchanged" as const, proposalId: current.id };

    const rejected = rows.find(
      (r) => r.status === ProposalStatus.REJECTED && matches(r, pending)
    );
    if (rejected) {
      await new TrustedIssuerService(
        tx as unknown as typeof db
      ).declineRequestedScopes(issuer.id, pending, rejected.id);
      return { action: "declined" as const, proposalId: rejected.id };
    }

    const owner = await (deps.resolveOwner ?? resolvePodOwnerUserId)();
    if (!owner) return { action: "no_owner" as const };

    const { proposal } = await insertPendingProposal(
      {
        workspaceId: null,
        targetType: TRUSTED_ISSUER_TARGET_TYPE,
        targetId: issuer.id,
        proposalType: TRUSTED_ISSUER_WIDEN_SCOPES_PROPOSAL_TYPE,
        data: buildWidenScopesData(issuer, pending) as unknown as Record<
          string,
          unknown
        >,
        createdBy: owner,
        proposedByUserId: null,
        // OWNER FLOOR (0248): the pod owner decides what the pod grants.
        subjectUserId: owner,
      },
      tx
    );
    return { action: "filed" as const, proposalId: proposal.id, owner };
  });

  if (!filed) return { action: "none" };
  if (filed.action !== "filed") return filed;

  const summary = buildWidenScopesData(issuer, pending).summary;
  // The ONE ordered door: the pod-wide fan-out completes before the
  // `proposal.created` emit, so the reactor arm finds the row and the owner is
  // told once.
  await notifyProposalCreatedOrdered({
    podWide: {
      proposalId: filed.proposalId,
      proposalType: TRUSTED_ISSUER_WIDEN_SCOPES_PROPOSAL_TYPE,
      description: summary,
    },
    sideEffect: {
      subjectId: filed.proposalId,
      userId: filed.owner,
      data: {
        proposalStatus: "created",
        targetType: TRUSTED_ISSUER_TARGET_TYPE,
        changeType: TRUSTED_ISSUER_WIDEN_SCOPES_PROPOSAL_TYPE,
      },
    },
    onEmitError: (err) => {
      logger.warn(
        { err, proposalId: filed.proposalId },
        "trusted-issuer scope request: emitSideEffects failed (non-fatal)"
      );
    },
  });
  return { action: "filed", proposalId: filed.proposalId };
}

/**
 * The proposal-row reads/writes the approve executor needs, kept OUT of
 * `routers/**` (the access-layer lint forbids raw scoped-table access there,
 * and its allowlist may only shrink). The executor stays the decision; these
 * are its two row touches.
 */
export async function isWidenScopesProposalApproved(
  proposalId: string
): Promise<boolean> {
  const [row] = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, proposalId));
  return row?.status === ProposalStatus.APPROVED;
}

/** Marks a still-PENDING widen-scopes proposal APPROVED by `userId`. */
export async function markWidenScopesProposalApproved(
  proposalId: string,
  userId: string
): Promise<void> {
  await db
    .update(proposals)
    .set({
      status: ProposalStatus.APPROVED,
      reviewedBy: userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(proposals.id, proposalId),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    );
}
