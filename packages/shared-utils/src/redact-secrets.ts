/**
 * redactSecrets — the ONE scrubber for free text that is about to be STORED,
 * emitted or handed to a model. Lives here so every package (api, jobs) uses
 * the same rules; `@synap/api`'s `utils/redact-secrets.ts` re-exports it.
 *
 * It is BEST-EFFORT, not a guarantee: redaction narrows the blast radius, a
 * read floor is what bounds the audience.
 *
 * Vault REFERENCES (`vault://…`, `secret_ref:…`) are deliberately NOT redacted —
 * they are pointers, not values, and they are exactly what makes a credential
 * failure explainable ("the token behind `vault://google/refresh` is expired").
 */
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
      // the real `executors/shared.ts` interpolation. `:` is part of the
      // credential: fal.ai's `Authorization: Key <key_id>:<key_secret>` kept
      // its secret half when the match stopped at the colon.
      .replace(
        /\bAuthorization\s*:\s*([A-Za-z][A-Za-z0-9-]*)\s+[A-Za-z0-9_\-.~+/:]+=*/gi,
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
      .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "***REDACTED_KEY***")
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
