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
  password: ["username", "!password", "url", "notes"],
  api_key: ["!key", "service", "notes"],
  credential: ["username", "!password", "notes"],
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
