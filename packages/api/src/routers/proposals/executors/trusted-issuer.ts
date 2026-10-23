import { TRPCError } from "@trpc/server";
import {
  db,
  getActingAgentUserId,
  TrustedIssuerService,
} from "@synap/database";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";
import { trustedIssuerCapabilitySchema } from "../../trusted-issuer-capabilities.js";
import {
  TRUSTED_ISSUER_TARGET_TYPE,
  TRUSTED_ISSUER_WIDEN_SCOPES_PROPOSAL_TYPE,
  proposalRequestedScopes,
  isWidenScopesProposalApproved,
  markWidenScopesProposalApproved,
} from "../../../services/trusted-issuers/scope-request-proposal.js";

/**
 * Approve-executor for `trusted_issuer/trusted_issuer.widen_scopes` — the
 * owner's YES to an issuer's request for scopes beyond its pinned grant (D7).
 * Filed only by `syncTrustedIssuerScopeRequest` at boot.
 *
 * WHO: a person who is a pod admin. The pod-admin floor runs before this
 * executor (`governanceApprovalFloorFor`), the approve door already refuses
 * an agent principal, and this executor refuses an acting agent once more —
 * the event key is a HUMAN GATE, so nothing below a person may say yes.
 *
 * WHAT: exactly the scopes the proposal names, and only while the issuer
 * still asks for them (`grantRequestedScopes` → `not_requested`, nothing
 * written). A revised payload therefore cannot grant a scope the issuer never
 * asked for, and an unknown scope name is refused before any write.
 */
export function registerTrustedIssuerExecutors(): void {
  registerProposalExecutor({
    key: `${TRUSTED_ISSUER_TARGET_TYPE}/${TRUSTED_ISSUER_WIDEN_SCOPES_PROPOSAL_TYPE}`,
    // Approving widens a credential: never from a device session.
    widensCredential: true,
    async execute({ proposal, userId, input, deps }) {
      if (getActingAgentUserId()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "A person approves what a trusted service may do here.",
        });
      }

      if (await isWidenScopesProposalApproved(input.proposalId)) {
        return { success: true, alreadyApproved: true };
      }

      const scopes = proposalRequestedScopes(proposal.data);
      const unknown = scopes.filter(
        (s) => !trustedIssuerCapabilitySchema.safeParse(s).success
      );
      if (scopes.length === 0 || unknown.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            scopes.length === 0
              ? "This access request names no scopes."
              : `This access request names scopes this pod does not know: ${unknown.join(", ")}.`,
        });
      }

      const result = await new TrustedIssuerService(db).grantRequestedScopes(
        proposal.targetId,
        userId,
        scopes
      );
      if (result.status === "not_found") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "This trusted service is no longer registered.",
        });
      }
      if (result.status === "not_approved") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `This trusted service is ${result.issuerStatus}; restore it before widening its access.`,
        });
      }
      if (result.status === "not_requested") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `The service no longer asks for: ${result.scopes.join(", ")}. Reject this request; a current one is filed on the next start.`,
        });
      }

      await markWidenScopesProposalApproved(input.proposalId, userId);

      reportApproved(deps, proposal, input.proposalId);
      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return {
        success: true,
        primaryId: result.issuer.id,
        effect: {
          applied: "verified" as const,
          // The issuer row `grantRequestedScopes` updated and RETURNED.
          rows: 1,
          ids: [result.issuer.id],
          subject: "trusted_issuers",
        },
      };
    },
  });
}
