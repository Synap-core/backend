"use strict";

/**
 * The Pod agent deliberately knows nothing about a particular control plane.
 * Its only trust inputs are an operator-configured issuer and this Pod's local
 * audience. Both must be canonical HTTPS identifiers so a signed command
 * cannot be replayed against another Pod or an alternate spelling of issuer.
 */

const MAX_COMMAND_TOKEN_LIFETIME_SECONDS = 30 * 60;
const CLOCK_SKEW_SECONDS = 60;

function normalizeHttpsUrl(rawValue) {
  if (typeof rawValue !== "string" || rawValue.length === 0) return null;

  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function readCanonicalSetting(environment, key) {
  const rawValue = environment[key] || "";
  const normalized = normalizeHttpsUrl(rawValue);
  if (!normalized) {
    return {
      value: null,
      error: `${key} must be a canonical HTTPS URL`,
    };
  }
  if (normalized !== rawValue) {
    return {
      value: null,
      error: `${key} must not contain a trailing slash, credentials, query, or fragment`,
    };
  }
  return { value: normalized, error: null };
}

function resolvePodAgentTrust(environment = process.env) {
  const issuer = readCanonicalSetting(environment, "POD_AGENT_ISSUER_URL");
  const audience = readCanonicalSetting(environment, "POD_AGENT_AUDIENCE");

  if (issuer.error || audience.error) {
    return {
      configured: false,
      error: issuer.error || audience.error,
    };
  }

  return {
    configured: true,
    issuerUrl: issuer.value,
    audience: audience.value,
    jwksUrl: `${issuer.value}/.well-known/jwks.json`,
  };
}

function hasExactAudience(aud, expectedAudience) {
  if (typeof aud === "string") return aud === expectedAudience;
  return (
    Array.isArray(aud) &&
    aud.some((candidate) => candidate === expectedAudience)
  );
}

function resolveCommandName(payload) {
  const command =
    typeof payload.command === "string" && payload.command.length > 0
      ? payload.command
      : null;
  // `type` is kept for rolling upgrades. New issuers should use `command`.
  const legacyType =
    typeof payload.type === "string" && payload.type.length > 0
      ? payload.type
      : null;

  if (command && legacyType && command !== legacyType) {
    throw new Error("conflicting command claims");
  }
  if (!command && !legacyType) {
    throw new Error("missing command claim");
  }
  return command || legacyType;
}

function validateSignedCommandClaims(
  payload,
  trust,
  nowSeconds = Math.floor(Date.now() / 1000)
) {
  if (!trust.configured) {
    throw new Error(trust.error || "pod-agent trust is not configured");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("malformed JWT payload");
  }
  if (payload.iss !== trust.issuerUrl) {
    throw new Error("untrusted issuer");
  }
  if (!hasExactAudience(payload.aud, trust.audience)) {
    throw new Error("wrong audience");
  }
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= nowSeconds) {
    throw new Error("expired or missing exp");
  }
  if (!Number.isSafeInteger(payload.iat)) {
    throw new Error("missing iat");
  }
  if (payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new Error("iat is in the future");
  }
  if (
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > MAX_COMMAND_TOKEN_LIFETIME_SECONDS
  ) {
    throw new Error("command token lifetime is invalid");
  }
  if (
    typeof payload.jti !== "string" ||
    payload.jti.length === 0 ||
    payload.jti.length > 512
  ) {
    throw new Error("missing jti");
  }

  return resolveCommandName(payload);
}

/**
 * An `update` command must name the release it installs. A missing version
 * used to become `latest` — a mutable tag that silently changes meaning, so a
 * bare update command could install anything (update-door plan P0,
 * 2026-10-04). The value lands in update-pod.sh's `sed` and in a docker tag,
 * so it must also be a valid docker tag.
 */
const DOCKER_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function invalidPayload(message) {
  const error = new Error(message);
  error.code = "INVALID_COMMAND_PAYLOAD";
  return error;
}

function validateUpdateTargetVersion(payload) {
  const version = payload ? payload.targetVersion : undefined;
  if (typeof version !== "string" || version.length === 0) {
    throw invalidPayload("update requires targetVersion (no implicit latest)");
  }
  if (!DOCKER_TAG_PATTERN.test(version)) {
    throw invalidPayload("targetVersion is not a valid image tag");
  }
  return version;
}

// ── configure: what a signed command may write into the Pod's .env ──
//
// configure-pod.sh writes every KEY=VALUE argument as ONE LINE of a pairs file
// that env-config.sh then reads line by line. A value carrying a newline was
// therefore a SECOND, unchecked pair — e.g. `FOO=x\nPOD_AGENT_ISSUER_URL=…`
// re-pointed the agent's own trust anchor past the key check below (H6,
// security wave 2026-10-13). Control characters are refused here, before any
// argv is built, and the key set a command may never touch is enforced on the
// same parsed entries the script receives.

const CONFIGURE_ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
// \n and \r split the pairs file; NUL truncates argv in the kernel.
const CONFIGURE_FORBIDDEN_CHARACTERS = /[\n\r\0]/;
/**
 * Keys no signed command may set, even when empty: the agent's own issuer,
 * the control-plane transport the installer writes once at registration
 * (`synap` register), and the operator's bootstrap credential. Every
 * `immutable` key of deploy/env.schema joins this set at validation time.
 * POD_AGENT_AUDIENCE is NOT here: a warm-pod claim legitimately moves it,
 * always together with PUBLIC_URL (enforced below).
 */
const CONFIGURE_NEVER_KEYS = Object.freeze([
  "POD_AGENT_ISSUER_URL",
  "CONTROL_PLANE_URL",
  "PROVISIONING_TOKEN",
]);
// docker compose profile / service names.
const COMPOSE_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

/**
 * The `immutable` keys of deploy/env.schema (exact names, and `PREFIX*`
 * entries as prefixes). Parsed with the same column rules env-config.sh uses:
 * `KEY TYPE FLAGS`, `#` comments and blank lines skipped.
 */
function parseImmutableEnvKeys(schemaText) {
  const exact = new Set();
  const prefixes = [];
  for (const rawLine of String(schemaText).split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [key, , flags = "-"] = line.split(/\s+/);
    if (!flags.split(",").includes("immutable")) continue;
    if (key.endsWith("*")) prefixes.push(key.slice(0, -1));
    else exact.add(key);
  }
  return { exact, prefixes };
}

function isImmutableKey(key, immutable) {
  return (
    immutable.exact.has(key) ||
    immutable.prefixes.some((prefix) => key.startsWith(prefix))
  );
}

/** The KEY=VALUE strings a configure payload carries — the ONE conversion. */
function configureEnvEntries(payload) {
  const raw = payload ? payload.envVars : undefined;
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") {
    return Object.entries(raw).map(([key, value]) => `${key}=${String(value)}`);
  }
  throw invalidPayload("envVars must be a list or an object");
}

/**
 * Validates a configure payload and returns its env as a Map. Never echoes a
 * value in an error (values are secrets: hub keys, SMTP URIs, B2 keys).
 *
 * @param payload   the verified command payload
 * @param immutable result of parseImmutableEnvKeys(env.schema) — REQUIRED and
 *                  non-empty when the payload carries env: a schema we could
 *                  not read must not silently widen what a command may write.
 */
function validateConfigurePayload(payload, immutable) {
  const entries = configureEnvEntries(payload);
  const values = new Map();

  if (entries.length > 0) {
    if (!immutable || immutable.exact.size + immutable.prefixes.length === 0) {
      const error = new Error("env schema unavailable — configure refused");
      error.code = "CONFIG_SCHEMA_UNAVAILABLE";
      throw error;
    }
  }

  for (const entry of entries) {
    if (typeof entry !== "string") {
      throw invalidPayload("invalid configure env var");
    }
    const separator = entry.indexOf("=");
    if (separator <= 0) throw invalidPayload("invalid configure env var");
    const key = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (!CONFIGURE_ENV_KEY_PATTERN.test(key)) {
      throw invalidPayload("configure env key must match ^[A-Z][A-Z0-9_]*$");
    }
    if (CONFIGURE_FORBIDDEN_CHARACTERS.test(value)) {
      throw invalidPayload(
        `configure value for ${key} contains a newline, carriage return or NUL`
      );
    }
    if (values.has(key)) {
      throw invalidPayload(`configure sets ${key} more than once`);
    }
    if (CONFIGURE_NEVER_KEYS.includes(key) || isImmutableKey(key, immutable)) {
      throw invalidPayload(`${key} cannot be changed by a command`);
    }
    values.set(key, value);
  }

  for (const field of ["profiles", "recreate"]) {
    const list = payload ? payload[field] : undefined;
    if (list === undefined || list === null) continue;
    if (
      !Array.isArray(list) ||
      list.some(
        (name) => typeof name !== "string" || !COMPOSE_NAME_PATTERN.test(name)
      )
    ) {
      throw invalidPayload(`configure ${field} must be compose names`);
    }
  }

  const nextAudience = values.get("POD_AGENT_AUDIENCE");
  const nextPublicUrl = values.get("PUBLIC_URL");
  if (nextAudience === undefined && nextPublicUrl === undefined) return values;
  if (nextAudience === undefined || nextPublicUrl === undefined) {
    throw invalidPayload(
      "POD_AGENT_AUDIENCE and PUBLIC_URL must change together"
    );
  }
  const normalizedAudience = normalizeHttpsUrl(nextAudience);
  const normalizedPublicUrl = normalizeHttpsUrl(nextPublicUrl);
  if (
    !normalizedAudience ||
    !normalizedPublicUrl ||
    normalizedAudience !== nextAudience ||
    normalizedPublicUrl !== nextPublicUrl ||
    normalizedAudience !== normalizedPublicUrl
  ) {
    throw invalidPayload(
      "POD_AGENT_AUDIENCE must be the canonical PUBLIC_URL for this Pod"
    );
  }
  return values;
}

// ── JWKS: keys by kid, refetched on an unknown kid ──
//
// The issuer rotates its signing key with a grace window (new kid published
// alongside the old). A 24 h cache that never looked again on an unknown kid
// refused every command signed with the new key for up to a day. An unknown
// kid now forces ONE refetch, rate-limited per JWKS URL so a stream of
// garbage kids cannot turn the agent into a JWKS request amplifier. Mirrors
// packages/api/src/utils/jwks-client.ts (getPublicKeyPem).

const JWKS_CACHE_TTL_MS = 86_400_000;
const JWKS_UNKNOWN_KID_REFETCH_MS = 60_000;

function parseJwksKeys(body, createPublicKey) {
  if (!body || !Array.isArray(body.keys)) throw new Error("invalid JWKS");
  const keys = new Map();
  for (const jwk of body.keys) {
    if (
      jwk &&
      typeof jwk.kid === "string" &&
      jwk.kid.length > 0 &&
      jwk.kty === "EC" &&
      jwk.alg === "ES256"
    ) {
      keys.set(jwk.kid, createPublicKey(jwk));
    }
  }
  return keys;
}

function createJwksKeyResolver({
  fetchJson,
  createPublicKey,
  now = Date.now,
  ttlMs = JWKS_CACHE_TTL_MS,
  unknownKidRefetchMs = JWKS_UNKNOWN_KID_REFETCH_MS,
  onFetched = () => {},
}) {
  const cache = new Map(); // url -> { keys, t, lastFetchAt }

  return async function getPublicKey(jwksUrl, kid) {
    const cached = cache.get(jwksUrl);
    const fresh = cached && now() - cached.t < ttlMs;
    if (fresh) {
      const key = cached.keys.get(kid);
      if (key) return key;
      // Unknown kid on a fresh cache: refetch at most once per window.
      if (now() - cached.lastFetchAt < unknownKidRefetchMs) {
        throw new Error("unknown signing key");
      }
    }
    if (cached) cached.lastFetchAt = now(); // claim the window before awaiting
    const keys = parseJwksKeys(await fetchJson(jwksUrl), createPublicKey);
    const fetchedAt = now();
    cache.set(jwksUrl, { keys, t: fetchedAt, lastFetchAt: fetchedAt });
    onFetched(jwksUrl);
    const key = keys.get(kid);
    if (!key) throw new Error("unknown signing key");
    return key;
  };
}

/** HTTP status for an error thrown while validating/accepting a command. */
function commandErrorStatus(error) {
  if (error && error.code === "INVALID_COMMAND_PAYLOAD") return 400;
  if (error && error.code === "REPLAY_PROTECTION_UNAVAILABLE") return 503;
  if (error && error.code === "CONFIG_SCHEMA_UNAVAILABLE") return 503;
  return 403;
}

module.exports = {
  CONFIGURE_NEVER_KEYS,
  MAX_COMMAND_TOKEN_LIFETIME_SECONDS,
  commandErrorStatus,
  configureEnvEntries,
  createJwksKeyResolver,
  parseImmutableEnvKeys,
  validateConfigurePayload,
  validateUpdateTargetVersion,
  normalizeHttpsUrl,
  resolvePodAgentTrust,
  resolveCommandName,
  validateSignedCommandClaims,
};
