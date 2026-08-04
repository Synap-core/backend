/**
 * ProtonConnector — a MessagingConnector for OUTBOUND Proton Mail sends.
 *
 * Like Discord, the backend is Proton-AGNOSTIC: it never talks to Proton. This
 * connector's `sendMessage` writes an abstract `post_message` intent to the
 * `channel_egress` outbox; a standalone Proton Bridge agent polls the outbox and
 * delivers the mail over its own IMAP/SMTP session. (See `proton-bridge-plan`.)
 *
 * WHY THE BACKEND BUILDS THE HEADERS: Stalwart's JMAP connector can derive reply
 * headers itself (it re-queries the thread over JMAP). A polling bridge cannot —
 * it has no live view of the mailbox at send time. So THIS connector reads the
 * bound channel + its last inbound message from the DB and hands the bridge a
 * fully-resolved envelope: `to` (the participant email), `subject` (`Re: <last
 * subject>`), and `inReplyTo` (the last inbound RFC822 Message-Id) for threading.
 *
 * FIREWALL: identical to DiscordConnector. A send that reaches this connector is
 * already governance-authorized upstream (`gateMessagingSend` in external-dispatch:
 * an un-approved AGENT send is proposed/denied and never gets here; owner +
 * approved-proposal sends are human-authorized). So the egress carries
 * `authorType: "human"` — a deliberate, authorized operator→party send the bridge
 * firewall must let through. The "block un-approved AI" guarantee lives upstream.
 *
 * Provider id: "proton". `sendMessage`'s `threadId` is the bound EXTERNAL
 * channel's `externalId` — exactly the egress `externalId`. The other
 * MessagingConnector methods are V0 stubs (inbound is owned by the bridge →
 * `/api/hub/messaging/inbound`, not synced through here).
 *
 * FROZEN egress payload (the bridge consumes it verbatim):
 *   { content, to, subject?, inReplyTo?, authorType }
 */

import {
  enqueueChannelEgress,
  db,
  eq,
  and,
  desc,
  channels,
  messages,
  ChannelType,
  MessageAuthorType,
} from "@synap/database";
import type {
  MessagingConnector,
  MessagingAccount,
  ConversationSummary,
  Message,
  WebhookEvent,
} from "./MessagingConnector.js";

export class ProtonConnector implements MessagingConnector {
  // The bridge holds the mailbox credentials; the backend only enqueues, so this
  // connector is always "configured" (no token to check here).
  isConfigured(): boolean {
    return true;
  }

  /**
   * Proton is bridge-managed (the bridge owns the login session), so it needs no
   * per-user messaging account. The send target is the bound EXTERNAL channel;
   * `sendMessage` ignores its accountId argument.
   */
  requiresAccount(): boolean {
    return false;
  }

  /**
   * Enqueue an outbound Proton Mail message. `threadId` is the bound EXTERNAL
   * channel's `externalId`. Never calls Proton — writes a `post_message` intent
   * the bridge delivers. Reads the channel + last inbound message from the DB to
   * resolve the reply envelope the bridge cannot derive itself.
   *
   * `subject` / `inReplyTo` are OPTIONAL in the frozen payload and are best-effort:
   * omitted when they cannot be resolved (a subject-less thread, or an inbound
   * whose RFC822 Message-Id was not persisted). The bridge still sends; the reply
   * just isn't threaded.
   */
  async sendMessage(
    _externalAccountId: string,
    threadId: string,
    body: string
  ): Promise<void> {
    const { to, subject, inReplyTo } = await resolveReplyEnvelope(threadId);

    await enqueueChannelEgress({
      externalSource: "proton",
      externalId: threadId,
      kind: "post_message",
      payload: {
        content: body,
        to,
        ...(subject ? { subject } : {}),
        ...(inReplyTo ? { inReplyTo } : {}),
        authorType: "human",
      },
    });
  }

  // ── Inbound / sync surface: not used in V0 (the bridge owns inbound) ─────────

  async getAuthUrl(): Promise<string> {
    throw new Error("ProtonConnector does not support hosted auth URLs");
  }

  async getAccounts(_userId: string): Promise<MessagingAccount[]> {
    return [];
  }

  async getConversations(): Promise<{
    items: ConversationSummary[];
    nextCursor?: string;
  }> {
    return { items: [] };
  }

  async getMessages(): Promise<Message[]> {
    return [];
  }

  async deleteAccount(): Promise<void> {
    // No-op: Proton accounts are managed by the bridge, not this connector.
  }

  async ensureWebhooksRegistered(): Promise<void> {
    // No-op: inbound Proton mail arrives via the bridge, not webhooks.
  }

  async parseWebhook(): Promise<WebhookEvent | null> {
    return null;
  }
}

/**
 * The bridge's egress envelope, resolved from the DB. `to` is required (an email
 * with no recipient is undeliverable — we throw). `subject`/`inReplyTo` are
 * best-effort and may be absent.
 */
interface ReplyEnvelope {
  to: string;
  subject?: string;
  inReplyTo?: string;
}

/**
 * Build the reply envelope for a Proton send by reading the bound channel and its
 * last INBOUND message from the DB.
 *
 *  - `to`        = the participant email. Cached on the channel as
 *                  `metadata.participantExternalId` by the inbound recorder; falls
 *                  back to `externalId` only when that IS an email (the address is
 *                  the channel key), never an entity id (strong-match channels key
 *                  on the entity, not the address).
 *  - `subject`   = `Re: <last subject>`. The inbound recorder FOLDS the subject
 *                  into the body as `Subject: <subject>\n\n<text>` (there is no
 *                  separate subject column, and `metadata.emailHeaders` carries no
 *                  subject), so it is ONLY recoverable by parsing that fold.
 *  - `inReplyTo` = the last inbound RFC822 Message-Id, read from
 *                  `metadata.emailHeaders.messageId` — persisted by the inbound
 *                  recorder from the bridge's `headerMessageId` (inbound-recorder
 *                  .ts:506). Absent (the reply sends unthreaded) only until the
 *                  bridge supplies that header on delivery.
 */
async function resolveReplyEnvelope(threadId: string): Promise<ReplyEnvelope> {
  const channel = await db.query.channels.findFirst({
    where: and(
      eq(channels.channelType, ChannelType.EXTERNAL),
      eq(channels.externalSource, "proton"),
      eq(channels.externalId, threadId)
    ),
    columns: { id: true, metadata: true, externalId: true },
  });
  if (!channel) {
    throw new Error(
      `ProtonConnector: no Proton channel bound to externalId "${threadId}"`
    );
  }

  const meta = (channel.metadata ?? {}) as Record<string, unknown>;
  const participantEmail =
    typeof meta.participantExternalId === "string"
      ? meta.participantExternalId
      : undefined;
  const to =
    participantEmail ??
    (channel.externalId && channel.externalId.includes("@")
      ? channel.externalId
      : undefined);
  if (!to) {
    throw new Error(
      `ProtonConnector: cannot resolve a recipient email for Proton channel "${threadId}"`
    );
  }

  // Last INBOUND (from the participant) message — the one we're replying to. Its
  // headers thread the reply.
  const lastInbound = await db.query.messages.findFirst({
    where: and(
      eq(messages.channelId, channel.id),
      eq(messages.authorType, MessageAuthorType.EXTERNAL)
    ),
    orderBy: [desc(messages.timestamp)],
    columns: { content: true, metadata: true },
  });

  let subject: string | undefined;
  let inReplyTo: string | undefined;
  if (lastInbound) {
    const emailHeaders = (
      (lastInbound.metadata ?? {}) as Record<string, unknown>
    ).emailHeaders as { messageId?: string } | undefined;

    // Subject has no metadata home — the inbound recorder folds it into the body
    // (`Subject: <s>\n\n<text>`), so it is ONLY recoverable by parsing that fold.
    const rawSubject = parseFoldedSubject(lastInbound.content);
    if (rawSubject) {
      subject = /^re:/i.test(rawSubject.trim())
        ? rawSubject.trim()
        : `Re: ${rawSubject.trim()}`;
    }

    // In-Reply-To = the inbound message's own RFC822 Message-Id, persisted by the
    // inbound recorder under `metadata.emailHeaders.messageId` from the bridge's
    // `headerMessageId`. Absent (unthreaded) until the bridge supplies that header.
    if (typeof emailHeaders?.messageId === "string" && emailHeaders.messageId) {
      inReplyTo = emailHeaders.messageId;
    }
  }

  return {
    to,
    ...(subject ? { subject } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
  };
}

/**
 * Extract the folded subject from an inbound email body. The inbound recorder
 * folds `Subject: <subject>\n\n<text>` (see land-inbound-message.ts). Returns the
 * subject line's value, or undefined when the body was not subject-folded.
 */
function parseFoldedSubject(content: string): string | undefined {
  const firstLine = content.split("\n", 1)[0] ?? "";
  const m = firstLine.match(/^Subject:\s*(.+)$/);
  return m ? m[1].trim() : undefined;
}
