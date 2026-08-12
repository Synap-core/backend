/**
 * Message Shape — the ONE door for evaluating a `MessageShapePredicate`
 * against a normalized message envelope.
 *
 * Extracted from the automation trigger matcher (`@synap/jobs`) so BOTH
 * consumers share one matcher instead of forking it:
 *   - the automation matcher (`automation-trigger-matcher.ts`) narrows WHICH
 *     messages fire an automation, and
 *   - the guideline resolver (`resolveGuidelines`, config-settings.ts) narrows
 *     WHICH shape-scoped guidelines apply to a message being interpreted.
 *
 * It lives in `@synap/database` (which `@synap/jobs` already depends on, and
 * which never depends on jobs) so the move is dependency-safe. The
 * `MessageShapePredicate` type it evaluates is already defined here, in
 * `schema/automations.ts`.
 */

import type { MessageShapePredicate } from "../schema/automations.js";

/**
 * A SAFE, bounded, normalized view of a message — the shape matcher's input.
 * The automation matcher derives one from either physical message event
 * (`external_message.received` / `channel_message.created`); the guideline
 * resolver derives one from the `message.interpret` verb's content + channel.
 * Fields are honest to the source: anything the source did not carry stays
 * undefined, so a predicate over an absent field simply won't match (never
 * fabricated).
 */
export interface MessageEnvelope {
  channelId?: string;
  channelType?: string;
  bridgeId?: string;
  provider?: string;
  participant?: string;
  content?: string;
  attachments: Array<{ type?: string; url?: string }>;
  entityId?: string;
}

/** Bounded http(s) URL sniff — used by the `has_url` shape op. */
export const URL_SNIFF_RE = /https?:\/\/[^\s]+/i;

/**
 * Evaluate a `shape` predicate against the derived envelope. SAFE by
 * construction: content is bounded to 4k here, the regex SOURCE is length-capped,
 * and construction + test are wrapped in try/catch so a malformed OR pathological
 * pattern rejects (returns false) rather than throwing or hanging the caller. A
 * missing envelope (non-message context) fails closed.
 */
export function matchMessageShape(
  shape: MessageShapePredicate,
  envelope: MessageEnvelope | undefined
): boolean {
  if (!envelope) return false;
  const content = (envelope.content ?? "").slice(0, 4000);

  switch (shape.op) {
    case "has_attachment":
      return envelope.attachments.length > 0;
    case "has_url":
      return URL_SNIFF_RE.test(content);
    case "contains": {
      if (!shape.value) return false;
      return content.toLowerCase().includes(shape.value.toLowerCase());
    }
    case "from_participant": {
      if (!shape.value || !envelope.participant) return false;
      return envelope.participant.toLowerCase() === shape.value.toLowerCase();
    }
    case "regex": {
      if (!shape.value) return false;
      // Reject an over-long source outright: a huge pattern is the cheapest ReDoS
      // vector and no legitimate shape filter needs one. Content is already
      // bounded to 4k above, which caps backtracking on a valid-but-evil regex.
      if (shape.value.length > 200) return false;
      try {
        return new RegExp(shape.value).test(content);
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}
