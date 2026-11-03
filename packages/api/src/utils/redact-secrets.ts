import { redactSecrets } from "@synap/shared-utils";
import {
  isSecretFieldValue,
  redactSecretValues,
} from "@synap-core/types/vault";

/**
 * redactSecrets — the ONE scrubber for free text that is about to be STORED or
 * handed to a model.
 *
 * Lifted verbatim (then widened) from the private copy in
 * `hub-protocol/rest/commands.ts`, which redacted command stdout/stderr before
 * returning it. A second copy is a fork the moment it exists, and the second
 * caller has now arrived: a failed proposal persists the raw executor error as
 * `data.failure.detail` so the AI can explain the failure — raw upstream error
 * bodies routinely echo the Authorization header that produced them.
 *
 * It is BEST-EFFORT, not a guarantee. It is the reason `detail` is additionally
 * kept off every user-facing read door (see `failure-projection.ts`): redaction
 * narrows the blast radius, the projection floor is what bounds the audience.
 *
 * Vault REFERENCES (`vault://…`, `secret_ref:…`) are deliberately NOT redacted —
 * they are pointers, not values, and they are exactly what makes a credential
 * failure explainable ("the token behind `vault://google/refresh` is expired").
 *
 * The function itself lives in `@synap/shared-utils` (audit F8, 2026-10-28) so
 * the jobs materializer redacts an approved command's output with the same
 * rules; it is re-exported here for every existing api caller.
 */

/** Hard cap on a stored/redacted detail string — bounded, no unbounded blobs. */
export const REDACTED_DETAIL_MAX = 600;

export { redactSecrets };

/** Redact, collapse whitespace and clamp — the form stored on a failed row. */
export function redactForStorage(
  text: string,
  max: number = REDACTED_DETAIL_MAX
): string {
  const scrubbed = redactSecrets(text).replace(/\s+/g, " ").trim();
  return scrubbed.length > max ? `${scrubbed.slice(0, max - 1)}…` : scrubbed;
}

/** Depth bound for {@link redactDeepForStorage} — cheap, and a cycle can't win. */
const REDACT_DEPTH_LIMIT = 8;

/**
 * Redact every STRING inside an arbitrary JSON-ish value, in place-free form.
 *
 * ## Why this exists
 *
 * `data.failure.detail` is not the only place a failed proposal parks error
 * text. Two SIBLING writers park structured error payloads directly on `data`,
 * where `projectProposalDataForViewer` deliberately does not reach (those
 * payloads ARE what the reviewer reads — a plan report with its reasons
 * stripped is useless):
 *
 *   · `runMaterializationUnderReceipt` → `data.materializationError`
 *   · `apply-approval` (composite plan) → `data.planFailure.steps[].reason`
 *     and `data.planFailure.compensation.notCompensated[].reason`
 *
 * Those strings are the SAME raw upstream text `detail` is redacted from, and
 * they were stored verbatim. Since they must stay visible, they must be
 * redacted AT WRITE — which is what this does, for a whole payload at once, so
 * a writer cannot redact three of four nested fields and call it done.
 *
 * Numbers, booleans and nulls pass through unchanged; only strings are touched.
 */
export function redactDeepForStorage<T>(
  value: T,
  max: number = REDACTED_DETAIL_MAX,
  depth = 0
): T {
  if (typeof value === "string") return redactForStorage(value, max) as T;
  if (depth >= REDACT_DEPTH_LIMIT || !value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeepForStorage(v, max, depth + 1)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactDeepForStorage(v, max, depth + 1);
  }
  return out as T;
}

// ── Secret-bearing KEYS in a structured payload ─────────────────────────────

/**
 * A payload key whose VALUE is a credential: `authorization_token`,
 * `access_token`, `client_secret`, `apiKey`, `password`, `Authorization`…
 * Narrower than the install-param rule (`isSecretParamName`, which matches
 * any `key`): a stored provider body keeps `keyRef`, `idempotencyKey`,
 * `keyword` — redacting those would corrupt a legitimate replay.
 */
const SECRET_PAYLOAD_KEY =
  /token|secret|password|passwd|passphrase|private[_-]?key|api[_-]?key|authorization|credential|cookie/i;

/**
 * A key NAMED after a credential that holds a POINTER to it, not the
 * credential: `secretId`, `credential_ids`, `tokenRef`, `npmTokenVaultRef`.
 * Masking one hid which secret an audit line or a stored body was about, and
 * made `carriesRedactedSecret` refuse to replay a body that held only an id.
 */
const SECRET_POINTER_KEY = /(?:id|ids|uuid|ref|refs)$/i;

/**
 * Is `key` a payload key whose value is a credential? The ONE key rule, read
 * by {@link redactSecretKeys} (a stored payload) and {@link redactPayloadForLog}
 * (an audit line); the free-text scrubber names the same words for a quoted
 * `"key":"value"` pair.
 */
export function isSecretPayloadKey(key: string): boolean {
  return SECRET_PAYLOAD_KEY.test(key) && !SECRET_POINTER_KEY.test(key);
}

/** What a redacted credential value reads as in a stored payload. */
export const REDACTED_SECRET_VALUE = "***REDACTED***";

/**
 * The ONE redactor for a structured payload about to be STORED where people
 * and agents read it (a proposal's `data.body`): every value under a
 * secret-bearing key is replaced, at any depth. A `vault://` reference is
 * kept — a pointer, not a credential. Numbers / booleans / null and every
 * other key pass through, so the payload stays reviewable.
 */
export function redactSecretKeys<T>(value: T, depth = 0): T {
  if (depth >= REDACT_DEPTH_LIMIT || !value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSecretKeys(v, depth + 1)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] =
      isSecretPayloadKey(k) &&
      typeof v === "string" &&
      v.trim() &&
      !/^vault:\/\//.test(v.trim())
        ? REDACTED_SECRET_VALUE
        : redactSecretKeys(v, depth + 1);
  }
  return out as T;
}

/**
 * Does a payload still carry a value `redactSecretKeys` replaced? A replay of
 * such a payload would send the marker as the credential — the caller refuses
 * it instead (the secret was never stored, so it cannot be replayed).
 */
export function carriesRedactedSecret(value: unknown, depth = 0): boolean {
  if (depth >= REDACT_DEPTH_LIMIT || !value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((v) => carriesRedactedSecret(v, depth + 1));
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([k, v]) =>
      (isSecretPayloadKey(k) && v === REDACTED_SECRET_VALUE) ||
      carriesRedactedSecret(v, depth + 1)
  );
}

// ── A mutation's input, about to be LOGGED ──────────────────────────────────

/**
 * A procedure path segment or a key that names a CREDENTIAL DOOR. Under one, a
 * neutral `value` key carries the secret itself: `secretsVault.create({ value })`,
 * `capabilities.credentials.add({ value })`.
 */
const CREDENTIAL_DOOR = /vault|secret|credential|password/i;

/**
 * A key whose whole value is a map of credentials even though its entries are
 * named freely: an MCP server's `env` (`NOTION_KEY`, `DB_PASS`).
 */
const CREDENTIAL_MAP_KEY = /^(?:env|environment)$/i;

/** Longest string scanned: a log keeps far less, and a 10 MB base64 body costs nothing. */
const LOG_SCAN_MAX = 16_384;

/** none: free text only; door: `value` is the secret; all: every string is. */
type LogSecrecy = 0 | 1 | 2;

/**
 * A copy of a mutation's input that is SAFE TO LOG: the ONE redactor the
 * tRPC audit log (`middleware/audit-log.ts`) calls. It keeps the payload's
 * shape and every readable field, because an audit line that hides every value
 * is useless, and removes:
 *  - a string under a credential key ({@link isSecretPayloadKey}), and every
 *    string inside an object or array held by one (`credentials: {…}`,
 *    `apiKeys: […]`, an `env` map); numbers and booleans stay (`maxTokens`);
 *  - `value` at a credential door: the procedure path or an ancestor key names
 *    a vault, a secret, a credential or a password. `secretsVault.create`
 *    sends its typed secret as `input.value` (CP ticket 84f82ed3);
 *  - a tagged form secret (`{ kind: "new", value }`, `@synap-core/types/vault`);
 *  - in every other string, what {@link redactSecrets} finds: `Bearer …`,
 *    `sk-…`, a JWT, a quoted `"api_key":"…"`.
 * A `vault://` reference is kept: a pointer, not a credential. Past the depth
 * bound an object or array is replaced, never passed through.
 */
export function redactPayloadForLog(
  input: unknown,
  procedurePath = ""
): unknown {
  const atDoor = procedurePath
    .split(".")
    .some((segment) => CREDENTIAL_DOOR.test(segment));
  return redactForLog(input, atDoor ? 1 : 0, 0);
}

function redactForLog(
  value: unknown,
  secrecy: LogSecrecy,
  depth: number
): unknown {
  if (typeof value === "string") {
    const scanned =
      value.length > LOG_SCAN_MAX
        ? `${value.slice(0, LOG_SCAN_MAX)}...[truncated]`
        : value;
    if (
      secrecy === 2 &&
      scanned.trim() &&
      !/^vault:\/\//.test(scanned.trim())
    ) {
      return REDACTED_SECRET_VALUE;
    }
    return redactSecrets(scanned);
  }
  if (value === null || typeof value !== "object") return value;
  if (isSecretFieldValue(value)) return redactSecretValues({ v: value }).v;
  if (depth >= REDACT_DEPTH_LIMIT) return REDACTED_SECRET_VALUE;
  if (Array.isArray(value)) {
    return value.map((v) => redactForLog(v, secrecy, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    let redacted: unknown;
    if (isSecretPayloadKey(key) || CREDENTIAL_MAP_KEY.test(key)) {
      redacted = redactForLog(v, 2, depth + 1);
    } else if (
      secrecy >= 1 &&
      key.toLowerCase() === "value" &&
      v !== null &&
      v !== undefined
    ) {
      redacted = REDACTED_SECRET_VALUE;
    } else {
      const next: LogSecrecy =
        secrecy === 0 && CREDENTIAL_DOOR.test(key) ? 1 : secrecy;
      redacted = redactForLog(v, next, depth + 1);
    }
    // defineProperty: a `__proto__` key becomes an own property of the copy.
    Object.defineProperty(out, key, {
      value: redacted,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
