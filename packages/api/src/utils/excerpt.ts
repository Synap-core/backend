/**
 * Excerpt truncation helper for realtime event payloads.
 *
 * Used by emit sites that ship a short preview of a message body across the
 * realtime bridge (e.g. `openclaw:message:received`, `synap:reply:routed`).
 * Privacy enforcement is the consumer's job — we just bound payload size at
 * the producer to keep the bridge light.
 */

/** Maximum characters in an excerpt before suffix is appended. */
export const EXCERPT_MAX_LEN = 120;

/**
 * Truncate a message body to {@link EXCERPT_MAX_LEN} characters. If the input
 * exceeds the limit, an ellipsis is appended (so total length is
 * `EXCERPT_MAX_LEN + 1`). Empty/undefined input → empty string.
 *
 * NOTE: this does NOT redact PII — that is the consumer's responsibility (see
 * eve-channels-design §5.2 "Privacy"). The whole point of truncating here is
 * to bound bridge payload size, not to scrub content.
 */
export function makeExcerpt(input: string | null | undefined): string {
  if (!input) return "";
  const trimmed = input.replace(/\s+/g, " ").trim();
  if (trimmed.length <= EXCERPT_MAX_LEN) return trimmed;
  return trimmed.slice(0, EXCERPT_MAX_LEN) + "…";
}
