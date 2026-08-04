/**
 * Provider-agnostic inbound-message lander.
 *
 * ONE door every external bridge (Discord, Proton/Mailgun-forward, and future
 * connectors) calls to place an inbound message into the pod's channel/message
 * substrate. It wraps the shared `recordInboundMessage` sensor recorder with the
 * two provider-agnostic value-adds that were previously duplicated per bridge:
 *
 *   1. SUBJECT FOLD — a provider with a subject line (email) has no separate
 *      subject field in the message substrate, so we fold
 *      "Subject: <subject>\n\n<text>" into the stored body. Mirrors the Mailgun
 *      mapper (`services/mailgun/map-inbound-to-message.ts`).
 *   2. EMAIL IDENTITY RESOLVE — when the caller supplies a participant email but
 *      no explicit channel key, resolve the sender to an existing entity via the
 *      strong `email` signal (one-channel-per-client). Unresolved falls back to
 *      the email itself as the channel key (unlinked-fallback) — the SAME posture
 *      the Mailgun inbound route uses (`routers/webhooks-inbound.ts`).
 *
 * This is a SENSOR write: it records what arrived from outside and is NOT
 * governed (it never turns an inbound message into a proposal). Callers gate on
 * the `hub-protocol.write` scope at the door; the recorder does the dedup/insert.
 *
 * Discord parity: the optional pass-through fields (`title`, `idempotencySeed`,
 * `senderExternalId`, `senderKeyId`, `attachments`) let the Discord bridge route
 * through this door and reach `recordInboundMessage` with byte-identical args.
 */

import { db, resolveIdentity } from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  recordInboundMessage,
  type RecordInboundMessageResult,
} from "./inbound-recorder.js";

const logger = createLogger({ module: "land-inbound-message" });

export interface LandInboundMessageArgs {
  /** Free-text provider name (e.g. "discord", "proton", "mailgun"). */
  provider: string;
  /** Message body (may be empty when only a subject/attachment is present). */
  text: string;
  /** Native provider message id — the idempotency key (default seed). */
  messageId: string;
  /**
   * Explicit channel key. When provided, the channel resolves against it
   * directly (email resolution is skipped). Discord passes the channel id here.
   */
  externalId?: string;
  /**
   * Participant email. When `externalId` is absent, the sender is resolved to an
   * existing entity via the strong `email` signal → the matched entity id
   * becomes the channel key (one-channel-per-client); unresolved falls back to
   * the email itself (unlinked-fallback).
   */
  participantEmail?: string;
  /** Participant display name (cached in channel metadata; default title). */
  participant?: string;
  /** Participant id in the external system (cached in channel metadata). */
  participantExternalId?: string;
  /** Subject line (email) — folded into the stored body when present. */
  subject?: string;
  /** Message timestamp; defaults to now inside the recorder. */
  sentAt?: string | Date;
  /** Workspace home for a freshly-created channel; `null`/absent = pod-level. */
  workspaceId?: string | null;
  /** Cross-cutting project lens for a freshly-created channel; `null`/absent = none. */
  projectId?: string | null;
  /** The acting (resolved) Synap user id. */
  userId: string;

  // ── Optional pass-throughs (provider parity — NOT part of the generic body) ──
  /** Channel title override for a freshly-created row (default: participant). */
  title?: string;
  /** Idempotency seed override (default: `messageId`). Discord uses `chan:msg`. */
  idempotencySeed?: string;
  /** External sender id for attribution lookup (paired with `senderKeyId`). */
  senderExternalId?: string;
  /** Operator API key id used to authenticate this delivery. */
  senderKeyId?: string;
  /** Inbound attachments (e.g. Discord photo embeds). */
  attachments?: { type: string; url: string; name?: string }[];
  /** RFC reply-threading headers (email) — carried + stored, not interpreted. */
  headerMessageId?: string;
  inReplyTo?: string;
  references?: string[];
}

export type LandInboundMessageResult = RecordInboundMessageResult & {
  /** Convenience inverse of `recorded` — true when this was a duplicate delivery. */
  deduped: boolean;
};

/**
 * Land an inbound external message into the pod's channel/message substrate.
 * Provider-agnostic: subject-fold + email-resolve, then the shared recorder.
 */
export async function landInboundMessage(
  args: LandInboundMessageArgs
): Promise<LandInboundMessageResult> {
  // 1. Fold the subject into the body (mirrors the Mailgun mapper).
  const text = args.subject
    ? args.text
      ? `Subject: ${args.subject}\n\n${args.text}`
      : `Subject: ${args.subject}`
    : args.text;

  // 2. Resolve the channel key. externalId wins; otherwise resolve the email to
  //    an existing entity via the strong `email` signal, unlinked-fallback to the
  //    email itself (same call + posture as the Mailgun inbound route).
  let externalId = args.externalId;
  if (!externalId && args.participantEmail) {
    let strongMatchEntityId: string | null = null;
    try {
      const resolution = await resolveIdentity(db, {
        userId: args.userId,
        signals: [{ type: "email", value: args.participantEmail }],
      });
      if (resolution.match === "strong" && resolution.entity) {
        strongMatchEntityId = resolution.entity.id;
      }
    } catch (err) {
      logger.warn(
        { err, provider: args.provider },
        "landInboundMessage: identity resolution failed — falling back to email channel"
      );
    }
    externalId = strongMatchEntityId ?? args.participantEmail;
  }

  if (!externalId) {
    throw new Error(
      "landInboundMessage: externalId or participantEmail is required to resolve a channel"
    );
  }

  // 3. Record via the shared sensor recorder (channel resolve + dedup insert +
  //    external_message.received emit). All args forwarded unchanged so a bridge
  //    already calling recordInboundMessage stays byte-identical through here.
  const result = await recordInboundMessage({
    provider: args.provider,
    externalId,
    userId: args.userId,
    workspaceId: args.workspaceId ?? null,
    projectId: args.projectId ?? null,
    text,
    participant: args.participant,
    participantExternalId: args.participantExternalId,
    title: args.title ?? args.participant ?? externalId,
    idempotencySeed: args.idempotencySeed ?? args.messageId,
    senderExternalId: args.senderExternalId,
    senderKeyId: args.senderKeyId,
    messageId: args.messageId,
    attachments: args.attachments,
    headerMessageId: args.headerMessageId,
    inReplyTo: args.inReplyTo,
    references: args.references,
    ...(args.sentAt !== undefined ? { sentAt: args.sentAt } : {}),
  });

  return { ...result, deduped: !result.recorded };
}
