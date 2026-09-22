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

/** The scheme every vault reference carries. Never spell it inline. */
export const VAULT_REF_PREFIX = "vault://";
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const VAULT_REF_PATTERN = new RegExp(
  `^${VAULT_REF_PREFIX}${UUID_PATTERN}$`
);

/**
 * Is this a WELL-FORMED, resolvable reference (`vault://<uuid>`)?
 *
 * Strict on purpose: a caller asking this is about to look the secret up, and
 * a malformed id is a lookup that cannot succeed.
 */
export function isVaultReference(value: unknown): value is string {
  return typeof value === "string" && VAULT_REF_PATTERN.test(value);
}

export function makeVaultReference(secretId: string): string {
  return `${VAULT_REF_PREFIX}${secretId}`;
}

/**
 * The secret id inside a `vault://<id>`, or `null` when the value is not a
 * reference at all.
 *
 * DELIBERATELY LENIENT, and NOT the same question as {@link isVaultReference}:
 * this answers "is this a POINTER rather than a literal value?". Anything
 * carrying the scheme is a pointer, even if its id is malformed. Tightening it
 * to `VAULT_REF_PATTERN` would make `vault://garbage` parse as a plain VALUE —
 * and a plain value is encrypted and stored AS the credential, so a capability
 * would authenticate with the literal text of a broken pointer. A malformed
 * pointer must fail to resolve, never quietly become a secret.
 *
 * Accepts `unknown` because its callers read untyped params/JSONB.
 */
export function parseVaultReference(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Trim the WHOLE value: {@link vaultSecretIdOf} does, and a padded pointer
  // that only one of the two recognised would be read as a literal credential
  // by the writer and as a pointer by the reader.
  const trimmed = value.trim();
  if (!trimmed.startsWith(VAULT_REF_PREFIX)) return null;
  const id = trimmed.slice(VAULT_REF_PREFIX.length).trim();
  return id.length > 0 ? id : null;
}

/**
 * The secret id inside a WELL-FORMED, resolvable reference, or `null` — the
 * third question, between the other two: "may this id go to the database?".
 *
 * Use it wherever the id is about to reach a `uuid` column. A malformed id
 * survives {@link parseVaultReference} (correctly — it must not be read as a
 * literal value), but in a `WHERE id = $1` or `inArray(id, […])` it throws a
 * Postgres cast error. In a batch that error is swallowed by the caller's
 * degrade path, so ONE planted `vault://x` turns every valid ref on the page
 * into "missing". Filter the id set through this, and treat a `null` here
 * (with a non-null {@link parseVaultReference}) as "points at nothing".
 */
export function vaultSecretIdOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return VAULT_REF_PATTERN.test(trimmed)
    ? trimmed.slice(VAULT_REF_PREFIX.length)
    : null;
}

// ============================================================================
// Secret FORM values — the tagged shape a credential takes inside a form
// ============================================================================

/**
 * The value of a `secret` form field. A DISCRIMINATED UNION, never a bare
 * string:
 *
 * - `{ kind: "existing", ref }` — a vault reference the person picked. Safe to
 *   log, persist and send.
 * - `{ kind: "new", value }` — a NEW key the person typed. `value` is the
 *   secret itself: it exists in form state only until the host writes it to the
 *   vault and swaps it for the resulting `ref`. It must NEVER be logged,
 *   persisted, echoed into a chat/context string, or attached to a proposal.
 *
 * A bare-string secret in form state is indistinguishable from any other text
 * answer, and every generic serialiser in this codebase would carry it. The
 * tagged shape is what lets {@link redactSecretValues} find a credential
 * WITHOUT knowing the form spec.
 *
 * This leaf is the ONE home for the rule, shared by the pod (capture parse
 * time), `@synap-core/property-renderer`, `@synap-core/capture-pipeline` and
 * relay. It imports nothing, so every one of them can reach it.
 */
export type SecretFieldValue =
  { kind: "existing"; ref: string } | { kind: "new"; value: string };

export function isSecretFieldValue(value: unknown): value is SecretFieldValue {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.kind === "existing" && typeof v.ref === "string") ||
    (v.kind === "new" && typeof v.value === "string")
  );
}

/** A secret value with nothing chosen / typed yet (counts as unanswered). */
export function isSecretValueEmpty(value: unknown): boolean {
  if (!isSecretFieldValue(value)) return true;
  return value.kind === "existing" ? value.ref === "" : value.value === "";
}

/** What a redacted `new` value carries in place of the typed key. */
export const REDACTED_SECRET = "[redacted]";

/**
 * A copy of `values` that is SAFE TO LOG and SAFE TO PERSIST: every
 * `{kind:"new"}` secret has its typed key replaced by {@link REDACTED_SECRET}.
 * An `{kind:"existing"}` ref passes through — a pointer is not a credential.
 *
 * Spec-independent (the value is self-describing), so it holds for a form whose
 * spec the caller does not have.
 *
 * ## It RECURSES (round-2 review). It used to be top-level only.
 *
 * The call site that matters is `CaptureAnswerSchema`, whose `values` is
 * `z.record(z.string(), z.unknown())` — so `{ profile: { apiKey: { kind:"new",
 * value:"sk-live-…" } } }` parsed cleanly and the plaintext key was persisted
 * into `messages.metadata.capturePart`, a JSONB column readable by every agent
 * for the life of the row. "Top-level only, matching the flat answer shape"
 * described the shape we EXPECTED, not the shape the schema ACCEPTS, and an
 * attacker (or a careless client) picks the second one.
 *
 * Recursion is a strict SUPERSET of the old contract, so the two other callers
 * (`@synap-core/capture-pipeline`, `@synap-core/property-renderer`) keep
 * exactly the behaviour they relied on for flat records.
 *
 * ## Fail-closed at the depth bound
 *
 * Bounded at {@link REDACT_DEPTH_LIMIT}. A payload nested deeper than that is
 * not a form answer, so BEYOND the bound any object or array is replaced
 * wholesale by {@link REDACTED_SECRET} rather than passed through — a tagged
 * secret is always an OBJECT, so nothing past the bound can hide one. Scalars
 * past the bound are kept: they cannot be a `SecretFieldValue`, and wiping
 * them would destroy data for no gain.
 *
 * Keys are copied with `defineProperty`, so a `__proto__` key in the payload
 * becomes an own property of the copy instead of invoking a setter.
 *
 * The result is for logging/telemetry/persistence, NOT for submission: passing
 * it to the vault would store the literal string "[redacted]".
 */
export const REDACT_DEPTH_LIMIT = 6;

export function redactSecretValues(
  values: Record<string, unknown>
): Record<string, unknown> {
  return redactSecretsIn(values, 0) as Record<string, unknown>;
}

function redactSecretsIn(value: unknown, depth: number): unknown {
  if (isSecretFieldValue(value)) {
    return value.kind === "new"
      ? { kind: "new", value: REDACTED_SECRET }
      : value;
  }
  if (value === null || typeof value !== "object") return value;
  // Past the bound, anything that could still CARRY a secret is an object or
  // an array — redact it rather than trust it.
  if (depth >= REDACT_DEPTH_LIMIT) return REDACTED_SECRET;
  if (Array.isArray(value)) {
    return value.map((v) => redactSecretsIn(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    Object.defineProperty(out, key, {
      value: redactSecretsIn(v, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
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
  "capability" | "tool" | "connection" | "entity" | "automation" | "url";

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
