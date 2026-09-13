/**
 * decodeHtmlEntities — the ONE door for turning HTML/XML entity escapes back
 * into plain text.
 *
 * WHY THIS EXISTS. Some LLM agents XML-escape their own tool-call arguments
 * before an MCP/Hub write — so a plain-text title like `Intake Doors & Surface
 * Spec` arrives at the pod already encoded as `Intake Doors &amp; Surface
 * Spec`. No pod write path HTML-escapes text on the way in (the only escaper
 * in the codebase, `hub-protocol/rest/setup.ts`, escapes for its own HTML
 * page on the way OUT), so a stored `&amp;` is not the pod's doing — it is
 * literally what the agent sent, and it must be decoded back to `&` wherever
 * that plain text is read as a title/name, not as markup.
 *
 * WHAT THIS DOES NOT COVER. This is a text decoder, not an HTML sanitizer —
 * never run it over document BODY/content, markdown, code, or arbitrary
 * property values that are allowed to contain literal ampersands as markup.
 * It exists for plain-text identity fields only (titles, names).
 *
 * SINGLE PASS. The whole string is scanned once, left to right, so a
 * double-escaped `&amp;amp;` decodes to `&amp;` — never all the way to `&` in
 * one call. A second `&amp;` cannot in turn decode because the first pass's
 * match already consumed the leading `&` of the following `amp;`, leaving it
 * as inert text. Callers that genuinely need to unwind multiple rounds of
 * escaping must call this more than once explicitly — decoding to a fixpoint
 * automatically is not this function's job, and would make it ambiguous
 * whether a resulting literal `&word;` was real content or an artifact.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const ENTITY_PATTERN = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;

export function decodeHtmlEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(ENTITY_PATTERN, (match, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const codePoint = isHex
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (
        !Number.isFinite(codePoint) ||
        codePoint < 0 ||
        codePoint > 0x10ffff
      ) {
        return match;
      }
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}
