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
 */

/** Hard cap on a stored/redacted detail string — bounded, no unbounded blobs. */
export const REDACTED_DETAIL_MAX = 600;

export function redactSecrets(output: string): string {
  return (
    output
      // Generic key=value secrets (KEY=sk-..., TOKEN=abc123...)
      .replace(
        /\b(api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|credentials?)\s*[=:]\s*\S+/gi,
        "$1=***REDACTED***"
      )
      // An `Authorization:` header with ANY scheme. The `Bearer` rule below
      // covered exactly one scheme, so a provider body echoing
      // `Authorization: Basic <base64 user:pass>` — the single most common
      // shape after Bearer — sailed through both the storage redaction and
      // the approver-facing sentence. Found by the round-2 test that drives
      // the real `executors/shared.ts` interpolation.
      .replace(
        /\bAuthorization\s*:\s*([A-Za-z][A-Za-z0-9\-]*)\s+[A-Za-z0-9_\-.~+/]+=*/gi,
        "Authorization: $1 ***REDACTED***"
      )
      // Bearer tokens (also outside an Authorization header)
      .replace(/Bearer\s+[A-Za-z0-9_\-.~+/]+=*/gi, "Bearer ***REDACTED***")
      // Connection strings with passwords
      .replace(/:\/\/[^:\s]+:[^@\s]+@/g, "://***:***@")
      // AWS-style keys
      .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "***REDACTED_AWS_KEY***")
      // Vendor-prefixed API keys (OpenAI/Anthropic `sk-…`, GitHub `ghp_…`,
      // Slack `xoxb-…`) — the shapes that reach us inside a provider's own
      // error body, where no `key=` label precedes them.
      .replace(/\bsk-[A-Za-z0-9_\-]{16,}/g, "***REDACTED_KEY***")
      .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "***REDACTED_KEY***")
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "***REDACTED_KEY***")
      // JWTs (three base64url segments) — an expired access token is the single
      // most common thing an auth error quotes back at us.
      .replace(
        /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
        "***REDACTED_JWT***"
      )
      // Private keys
      .replace(
        /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
        "***REDACTED_PRIVATE_KEY***"
      )
  );
}

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
