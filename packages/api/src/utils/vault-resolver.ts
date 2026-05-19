// Canonical vault resolver now lives in @synap/database.
export {
  isVaultReference,
  parseVaultReference,
  resolveVaultSecret,
  resolveVaultReferences,
  getServiceSecret,
  upsertServiceSecret,
} from "@synap/database";
