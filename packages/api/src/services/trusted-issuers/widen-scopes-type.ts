/**
 * The `${targetType}/${proposalType}` of the owner-consent proposal for a
 * wider trusted-issuer grant (D7). A LEAF (imports nothing) so the approval
 * floor (`governanceApprovalFloorFor`) can name it without pulling the filer.
 * `proposal-class.ts` and `@synap/governance-policy` carry the same literal
 * by their own no-import rules; their tests pin them to these constants.
 */
export const TRUSTED_ISSUER_TARGET_TYPE = "trusted_issuer";
export const TRUSTED_ISSUER_WIDEN_SCOPES_PROPOSAL_TYPE =
  "trusted_issuer.widen_scopes";
