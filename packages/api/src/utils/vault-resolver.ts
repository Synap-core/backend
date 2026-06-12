// Canonical vault resolver now lives in @synap/database.
export {
  isVaultReference,
  parseVaultReference,
  resolveVaultSecret,
  resolveVaultReferences,
  getServiceSecret,
  upsertServiceSecret,
  consumeGrant,
  VaultGrantError,
} from "@synap/database";
export type { GrantDenialCode } from "@synap/database";
