// Canonical vault resolver now lives in @synap/database.
export {
  isVaultReference,
  parseVaultReference,
  resolveVaultSecret,
  resolveVaultReferences,
  getServiceSecret,
  upsertServiceSecret,
  findRedeemableGrant,
  incrementGrant,
  VaultGrantError,
} from "@synap/database";
export type { GrantDenialCode, GrantRedeemer } from "@synap/database";
