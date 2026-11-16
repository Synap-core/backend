/**
 * WHO IS ASKING for a proposal: moved to `@synap-core/types/proposals`
 * (`proposalRequester`, plan d717d6ac §6 D1) so pod admin, the browser and
 * relay read one derivation. This thin re-export keeps the Review, history
 * and detail imports unchanged until the Review lane moves them.
 */
export {
  proposalRequester,
  proposalRequesterParts,
  type ProposalActorRole,
  type ProposalPrincipalView,
  type ProposalRequesterFacts,
  type ProposalRequesterParts,
} from "@synap-core/types/proposals";
