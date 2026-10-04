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

/** HTTP status for an error thrown while validating/accepting a command. */
function commandErrorStatus(error) {
  if (error && error.code === "INVALID_COMMAND_PAYLOAD") return 400;
  if (error && error.code === "REPLAY_PROTECTION_UNAVAILABLE") return 503;
  return 403;
}

module.exports = {
  MAX_COMMAND_TOKEN_LIFETIME_SECONDS,
  commandErrorStatus,
  validateUpdateTargetVersion,
  normalizeHttpsUrl,
  resolvePodAgentTrust,
  resolveCommandName,
  validateSignedCommandClaims,
};
