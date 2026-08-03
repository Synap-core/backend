/**
 * Mailgun inbound-email → message-substrate mapper (PURE function; no I/O).
 *
 * Mailgun's inbound route POSTs `multipart/form-data` with the parsed MIME
 * message spread across named fields (Mailgun's "Parsed" format — see
 * https://documentation.mailgun.com/docs/mailgun/user-manual/receiving-forwarding-and-storing-messages/#parsed-messages-parameters).
 * This function turns that field bag into the exact shape
 * `recordInboundMessage` consumes: mirrors calcom/map-booking-to-graph.ts and
 * fireflies/map-transcript-to-message.ts — deterministic + pure, all I/O
 * (identity resolution, channel resolve, dedup, side-effects) lives in the
 * caller (the /mailgun/:token route).
 *
 * FORWARDING NUANCE (Proton Mail): a Proton user sets an auto-forward rule to
 * our Mailgun inbound address, so the message Mailgun receives is a FORWARD,
 * not the original send. A plain SMTP forward (the common case) rewrites the
 * envelope sender (Mailgun's `sender` field = Return-Path) to the forwarding
 * server, while the `From` header is normally preserved — so we prefer the
 * header `From` (parsed for an email address) over the envelope `sender`, then
 * fall back to `Reply-To`, then finally `sender`. LIMITATION: some forwarding
 * configurations rewrite `From` too (e.g. an SRS-rewritten or "resend as new"
 * forward) — in that case the client will never resolve from this field and
 * the message lands in the unlinked review queue instead of the wrong
 * (forwarder's) channel, which is the safe failure mode.
 */

/** The Mailgun inbound "Parsed" form fields we consume (all values are strings
 * once read off a FormData — Mailgun never sends these as files). */
export interface MailgunInboundFields {
  sender?: string | null;
  recipient?: string | null;
  subject?: string | null;
  "body-plain"?: string | null;
  "stripped-text"?: string | null;
  "Message-Id"?: string | null;
  From?: string | null;
  "Reply-To"?: string | null;
}

export interface MappedMailgunMessage {
  /** Mailgun's `Message-Id` header — the idempotency key. */
  messageId: string;
  subject: string;
  /**
   * `Subject: <subject>\n\n` header + stripped-text (quote/signature stripped)
   * when present, else body-plain. `recordInboundMessage` has no separate
   * subject field, so the subject rides along in the stored message body —
   * mirrors the header-then-body composition in fireflies' mapper.
   */
  text: string;
  /**
   * Best-guess ORIGINAL sender email, preferring From > Reply-To > envelope
   * sender (see forwarding nuance above). Empty string when nothing parses.
   */
  senderEmail: string;
  /** Envelope sender (Mailgun `sender` — Return-Path), for diagnostics. */
  envelopeSender: string;
  recipient: string;
}

/** Extract an email address from a header value: `"Name" <addr@x.com>` or a
 * bare `addr@x.com`. Returns "" when nothing matches. */
export function extractEmailAddress(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const angleMatch = raw.match(/<([^>]+)>/);
  const candidate = (angleMatch ? angleMatch[1] : raw).trim().toLowerCase();
  // Minimal sanity check — not a full RFC 5322 validator, just enough to
  // reject a display name with no address embedded.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : "";
}

/**
 * Map ONE Mailgun inbound "Parsed" payload to an inbound-message shape.
 *
 * `messageId` is threaded explicitly as a fallback for the rare case Mailgun
 * omits `Message-Id` (malformed origin message) — callers must still supply
 * something stable to dedup on (e.g. a hash of sender+subject+timestamp).
 */
export function mapMailgunInboundToMessage(
  fields: MailgunInboundFields,
  fallbackMessageId: string
): MappedMailgunMessage {
  const messageId =
    String(fields["Message-Id"] ?? "").trim() || fallbackMessageId;
  const subject = String(fields.subject ?? "").trim() || "(no subject)";
  const strippedText = String(fields["stripped-text"] ?? "").trim();
  const bodyPlain = String(fields["body-plain"] ?? "").trim();
  const body = strippedText || bodyPlain;
  const text = body ? `Subject: ${subject}\n\n${body}` : `Subject: ${subject}`;

  const envelopeSender = extractEmailAddress(fields.sender);
  const fromHeader = extractEmailAddress(fields.From);
  const replyTo = extractEmailAddress(fields["Reply-To"]);
  // Prefer the header From (survives a plain forward), then Reply-To, then
  // finally the envelope sender (always rewritten on a forward).
  const senderEmail = fromHeader || replyTo || envelopeSender;

  const recipient =
    extractEmailAddress(fields.recipient) ||
    String(fields.recipient ?? "").trim();

  return {
    messageId,
    subject,
    text,
    senderEmail,
    envelopeSender,
    recipient,
  };
}
