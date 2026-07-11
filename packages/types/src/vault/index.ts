/**
 * Vault Types
 *
 * Shared type definitions for the Secrets Vault.
 * Used by browser (Electron), backend, and property system.
 */

// ============================================================================
// Secret Types
// ============================================================================

export const SECRET_TYPES = [
  "password",
  "api_key",
  "credential",
  "note",
  "card",
  "identity",
  "ssh_key",
  "certificate",
  "env_variable",
  "database",
  "oauth",
] as const;

export type SecretType = (typeof SECRET_TYPES)[number];

export const SECRET_TYPE_LABELS: Record<SecretType, string> = {
  password: "Password",
  api_key: "API Key",
  credential: "Credential",
  note: "Secure Note",
  card: "Payment Card",
  identity: "Identity",
  ssh_key: "SSH Key",
  certificate: "Certificate",
  env_variable: "Environment Variable",
  database: "Database",
  oauth: "OAuth Token",
};

/**
 * Fields available for each secret type.
 * Sensitive fields (passwords, keys, tokens) are marked with a leading `!`.
 */
export const SECRET_TYPE_FIELDS: Record<SecretType, string[]> = {
  password: ["username", "!password", "!totp", "url", "notes"],
  api_key: ["!key", "service", "notes"],
  credential: ["username", "!password", "!totp", "notes"],
  note: ["content"],
  card: ["cardHolder", "!cardNumber", "!cardExpiry", "!cardCvv", "notes"],
  identity: ["firstName", "lastName", "email", "phone", "address", "notes"],
  ssh_key: ["!privateKey", "publicKey", "!passphrase", "notes"],
  certificate: ["!certificate", "!privateKey", "chain", "notes"],
  env_variable: ["key", "!value", "environment", "notes"],
  database: [
    "host",
    "port",
    "database",
    "username",
    "!password",
    "!connectionString",
    "notes",
  ],
  oauth: [
    "clientId",
    "!clientSecret",
    "!accessToken",
    "!refreshToken",
    "!totp",
    "tokenUrl",
    "notes",
  ],
};

/** Human-readable labels for secret field keys */
export const SECRET_FIELD_LABELS: Record<string, string> = {
  username: "Username",
  password: "Password",
  url: "Website URL",
  notes: "Notes",
  key: "API Key",
  service: "Service Name",
  content: "Content",
  cardHolder: "Cardholder Name",
  cardNumber: "Card Number",
  cardExpiry: "Expiry (MM/YY)",
  cardCvv: "CVV",
  firstName: "First Name",
  lastName: "Last Name",
  email: "Email",
  phone: "Phone",
  address: "Address",
  privateKey: "Private Key",
  publicKey: "Public Key",
  passphrase: "Passphrase",
  certificate: "Certificate",
  chain: "Certificate Chain",
  value: "Value",
  environment: "Environment",
  host: "Host",
  port: "Port",
  database: "Database",
  connectionString: "Connection String",
  clientId: "Client ID",
  clientSecret: "Client Secret",
  accessToken: "Access Token",
  refreshToken: "Refresh Token",
  tokenUrl: "Token URL",
  totp: "One-time code (2FA)",
};

// ============================================================================
// Vault Reference Helpers
// ============================================================================

const VAULT_REF_PREFIX = "vault://";
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const VAULT_REF_PATTERN = new RegExp(
  `^${VAULT_REF_PREFIX}${UUID_PATTERN}$`
);

export function isVaultReference(value: unknown): value is string {
  return typeof value === "string" && VAULT_REF_PATTERN.test(value);
}

export function makeVaultReference(secretId: string): string {
  return `${VAULT_REF_PREFIX}${secretId}`;
}

export function parseVaultReference(ref: string): string | null {
  if (!ref.startsWith(VAULT_REF_PREFIX)) return null;
  return ref.slice(VAULT_REF_PREFIX.length);
}

/**
 * Check if a field key represents a sensitive field.
 * Sensitive fields are prefixed with `!` in SECRET_TYPE_FIELDS.
 */
export function isSensitiveField(fieldKey: string): boolean {
  return fieldKey.startsWith("!");
}

/** Strip the `!` prefix from a sensitive field key */
export function cleanFieldKey(fieldKey: string): string {
  return fieldKey.startsWith("!") ? fieldKey.slice(1) : fieldKey;
}

// ============================================================================
// Connected Vault DTOs
// ============================================================================

/** Kind of thing that consumes/uses a secret. */
export type SecretConsumerType =
  | "capability"
  | "tool"
  | "connection"
  | "entity"
  | "automation"
  | "url";

/**
 * One "this secret is used by X" record — surfaced in the Connections face.
 * Backed by the `secret_usages` join (falls back to `capability_id`/context).
 */
export interface SecretUsage {
  id: string;
  secretId: string;
  consumerType: SecretConsumerType;
  consumerId: string;
  consumerLabel: string;
  contextType?: string | null;
  contextId?: string | null;
  workspaceId?: string | null;
}

/**
 * A single grant of access to a secret (which agent/workspace can use it) —
 * surfaced in the Access face. Backed by `vault_grants`. This is the ONE
 * canonical shape: `listGrants`, `listAllGrants`, and `getDetailBundle.grants`
 * all return it. `secretName`/`secretType`/`granteeLabel`/`granteeType` are
 * only populated by `listAllGrants` (which spans multiple secrets and resolves
 * grantee identity); they are `null` from the per-secret endpoints.
 */
export interface SecretGrantView {
  grantId: string;
  grantedTo: string;
  scope: string;
  expiresAt?: string | null;
  /** Uses remaining: null = unlimited; clamped at 0 when exhausted. */
  usesRemaining?: number | null;
  workspaceId?: string | null;
  revokedAt?: string | null;
  /** True when not revoked, not expired, and uses remain. */
  active: boolean;
  /** Populated by `listAllGrants` only; null elsewhere. */
  secretName?: string | null;
  secretType?: SecretType | null;
  granteeLabel?: string | null;
  granteeType?: "user" | "agent" | "workspace" | null;
}

/**
 * A single audit event for a secret (created/revealed/copied/updated/shared) —
 * surfaced in the Activity face. Backed by `secret_audit_log`.
 */
export interface SecretActivityEvent {
  id: string;
  action: string;
  actorType: "user" | "agent";
  actorLabel?: string | null;
  createdAt: string;
}

/**
 * The full four-faces bundle for a secret detail view — identity metadata plus
 * where it is used, who can access it, and its recent activity. Fetched in one
 * call to reduce detail round-trips.
 */
export interface SecretDetailBundle {
  id: string;
  name: string;
  type: SecretType;
  category?: string | null;
  url?: string | null;
  description?: string | null;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
  usages: SecretUsage[];
  grants: SecretGrantView[];
  recentActivity: SecretActivityEvent[];
}
