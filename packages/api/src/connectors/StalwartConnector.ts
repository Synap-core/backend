import type {
  MessagingConnector,
  MessagingAccount,
  ConversationSummary,
  Message,
  WebhookEvent,
} from "./MessagingConnector.js";

/**
 * StalwartConnector — a MessagingConnector backed by a self-hosted Stalwart
 * mail server over JMAP (RFC 8620/8621). Lets the existing email/messaging
 * pipeline (EXTERNAL channels, proposal-gated sends, inbox UI) operate a
 * sovereign mailbox instead of a cloud aggregator.
 *
 * AUTH (security requirement): this connector authenticates with a dedicated,
 * least-privilege JMAP token (mailbox read + submit only), stored as
 * `bearerToken`. Eve mints this scoped token at provision time — the Stalwart
 * *admin* password is NEVER used here.
 *
 * Provider id: "stalwart". `externalSource` on EXTERNAL channels is "stalwart";
 * `externalId`/`threadId` is the JMAP threadId.
 *
 * Scope note: outbound (getAccounts/getConversations/getMessages/sendMessage)
 * and JMAP push wiring are implemented. Account lifecycle (create/delete) is
 * owned by Eve's provisioning, not this connector.
 */

export interface StalwartConnectorConfig {
  /** Stalwart JMAP base URL, e.g. https://mail.example.com (no trailing slash). */
  jmapUrl?: string;
  /** Least-privilege JMAP bearer token (read + submit). Never the admin password. */
  bearerToken?: string;
  /** The mailbox address this connector operates, e.g. me@example.com. */
  accountEmail?: string;
}

interface JmapSession {
  apiUrl: string;
  primaryAccounts: Record<string, string>;
  accounts: Record<string, { name?: string }>;
}

interface JmapInvocation {
  0: string;
  1: Record<string, unknown>;
  2: string;
}

interface JmapResponse {
  methodResponses: JmapInvocation[];
}

interface JmapEmail {
  id: string;
  threadId?: string;
  /** RFC822 Message-ID header values (NOT the JMAP id) — used for reply threading. */
  messageId?: string[];
  subject?: string;
  receivedAt?: string;
  preview?: string;
  keywords?: Record<string, boolean>;
  from?: Array<{ name?: string; email: string }>;
  to?: Array<{ name?: string; email: string }>;
  textBody?: Array<{ partId?: string }>;
  bodyValues?: Record<string, { value: string }>;
}

const MAIL_CAPS = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
const SUBMIT_CAPS = [...MAIL_CAPS, "urn:ietf:params:jmap:submission"];

export class StalwartConnector implements MessagingConnector {
  private readonly jmapUrl?: string;
  private readonly bearerToken?: string;
  private readonly accountEmail?: string;

  // Cached JMAP session (apiUrl + accountId) — resolved lazily.
  private session?: { apiUrl: string; accountId: string };

  constructor(config: StalwartConnectorConfig = {}) {
    this.jmapUrl = config.jmapUrl?.replace(/\/$/, "");
    this.bearerToken = config.bearerToken;
    this.accountEmail = config.accountEmail;
  }

  isConfigured(): boolean {
    return Boolean(this.jmapUrl && this.bearerToken);
  }

  // ── JMAP plumbing ─────────────────────────────────────────────────────────

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.bearerToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  /** Resolve (and cache) the JMAP session: API URL + primary mail accountId. */
  private async getSession(): Promise<{ apiUrl: string; accountId: string }> {
    if (this.session) return this.session;
    if (!this.isConfigured())
      throw new Error("StalwartConnector is not configured");

    const res = await fetch(`${this.jmapUrl}/.well-known/jmap`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(
        `JMAP session fetch failed: ${res.status} ${res.statusText}`
      );
    }
    const session = (await res.json()) as JmapSession;
    const accountId = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
    if (!accountId) throw new Error("JMAP session has no primary mail account");
    this.session = { apiUrl: session.apiUrl, accountId };
    return this.session;
  }

  /** POST a JMAP request and return the raw method responses. */
  private async jmap(
    using: string[],
    methodCalls: JmapInvocation[]
  ): Promise<JmapResponse> {
    const { apiUrl } = await this.getSession();
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ using, methodCalls }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `JMAP call failed: ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`
      );
    }
    return (await res.json()) as JmapResponse;
  }

  private static bodyText(email: JmapEmail): string {
    const partId = email.textBody?.[0]?.partId;
    if (partId && email.bodyValues?.[partId])
      return email.bodyValues[partId].value;
    return email.preview ?? "";
  }

  private async fetchEmails(
    ids: string[],
    accountId: string
  ): Promise<JmapEmail[]> {
    if (ids.length === 0) return [];
    const resp = await this.jmap(MAIL_CAPS, [
      [
        "Email/get",
        {
          accountId,
          ids,
          properties: [
            "id",
            "threadId",
            "messageId",
            "subject",
            "receivedAt",
            "preview",
            "keywords",
            "from",
            "to",
            "textBody",
            "bodyValues",
          ],
          fetchTextBodyValues: true,
        },
        "g",
      ] as unknown as JmapInvocation,
    ]);
    const list = (resp.methodResponses[0]?.[1]?.list ?? []) as JmapEmail[];
    return list;
  }

  // ── MessagingConnector ──────────────────────────────────────────────────────

  /**
   * Stalwart accounts are provisioned by Eve (via the admin API), not via a
   * hosted OAuth flow. There is no auth URL to hand a user to.
   */
  async getAuthUrl(): Promise<string> {
    throw new Error(
      "Stalwart mailboxes are provisioned through Eve, not a hosted auth flow."
    );
  }

  async getAccounts(): Promise<MessagingAccount[]> {
    if (!this.isConfigured()) return [];
    const { accountId } = await this.getSession();
    const email = this.accountEmail ?? accountId;
    return [
      {
        id: accountId,
        externalId: accountId,
        provider: "stalwart",
        displayName: email,
        status: "connected",
      },
    ];
  }

  async getConversations(
    externalAccountId: string
  ): Promise<{ items: ConversationSummary[]; nextCursor?: string }> {
    const { accountId } = await this.getSession();
    const acct = externalAccountId || accountId;

    // Query the most recent emails, newest first.
    const queryResp = await this.jmap(MAIL_CAPS, [
      [
        "Email/query",
        {
          accountId: acct,
          sort: [{ property: "receivedAt", isAscending: false }],
          limit: 50,
        },
        "q",
      ] as unknown as JmapInvocation,
    ]);
    const ids = (queryResp.methodResponses[0]?.[1]?.ids ?? []) as string[];
    const emails = await this.fetchEmails(ids, acct);

    // Collapse to one summary per thread (the newest email wins).
    const byThread = new Map<string, ConversationSummary>();
    for (const e of emails) {
      const threadId = e.threadId ?? e.id;
      if (byThread.has(threadId)) continue;
      const sender = e.from?.[0];
      byThread.set(threadId, {
        externalThreadId: threadId,
        provider: "stalwart",
        participantName: sender?.name ?? sender?.email ?? "(unknown)",
        participantExternalId: sender?.email ?? "",
        lastMessageAt: e.receivedAt ?? new Date(0).toISOString(),
        lastMessagePreview: e.preview ?? e.subject ?? "",
        unread: e.keywords ? e.keywords["$seen"] !== true : false,
      });
    }
    return { items: Array.from(byThread.values()) };
  }

  async getMessages(
    externalAccountId: string,
    threadId: string
  ): Promise<Message[]> {
    const { accountId } = await this.getSession();
    const acct = externalAccountId || accountId;

    // Resolve the emails in this thread, then fetch their content.
    const threadResp = await this.jmap(MAIL_CAPS, [
      [
        "Thread/get",
        { accountId: acct, ids: [threadId] },
        "t",
      ] as unknown as JmapInvocation,
    ]);
    const threads = (threadResp.methodResponses[0]?.[1]?.list ?? []) as Array<{
      emailIds?: string[];
    }>;
    const emailIds = threads[0]?.emailIds ?? [];
    const emails = await this.fetchEmails(emailIds, acct);

    const myEmail = this.accountEmail?.toLowerCase();
    return emails
      .sort((a, b) => (a.receivedAt ?? "").localeCompare(b.receivedAt ?? ""))
      .map((e) => {
        const sender = e.from?.[0];
        const direction: Message["direction"] =
          myEmail && sender?.email?.toLowerCase() === myEmail
            ? "outbound"
            : "inbound";
        return {
          externalMessageId: e.id,
          threadId: e.threadId ?? threadId,
          senderName: sender?.name ?? sender?.email ?? "(unknown)",
          body: StalwartConnector.bodyText(e),
          sentAt: e.receivedAt ?? new Date(0).toISOString(),
          direction,
        };
      });
  }

  /**
   * Reply to a thread: build a draft referencing the latest message, then
   * submit it via EmailSubmission. (Outbound here is already proposal-gated
   * upstream — the IS only calls this after the user approves the proposal.)
   */
  async sendMessage(
    externalAccountId: string,
    threadId: string,
    body: string
  ): Promise<void> {
    const { accountId } = await this.getSession();
    const acct = externalAccountId || accountId;

    // Resolve the thread's emails once, then take the latest to derive reply
    // headers (recipient, subject, and the parent Message-ID for threading).
    const threadResp = await this.jmap(MAIL_CAPS, [
      [
        "Thread/get",
        { accountId: acct, ids: [threadId] },
        "t",
      ] as unknown as JmapInvocation,
    ]);
    const threads = (threadResp.methodResponses[0]?.[1]?.list ?? []) as Array<{
      emailIds?: string[];
    }>;
    const emailIds = threads[0]?.emailIds ?? [];
    const emails = await this.fetchEmails(emailIds, acct);
    const latest = emails.sort((a, b) =>
      (b.receivedAt ?? "").localeCompare(a.receivedAt ?? "")
    )[0];

    const fromAddr = this.accountEmail;
    if (!fromAddr)
      throw new Error("StalwartConnector: accountEmail is required to send");
    const replyTo = latest?.from?.[0]?.email;
    if (!replyTo)
      throw new Error("Could not resolve a recipient for the reply");
    const subject = latest?.subject?.startsWith("Re:")
      ? latest.subject
      : `Re: ${latest?.subject ?? ""}`.trim();

    // Find the Drafts mailbox.
    const mbResp = await this.jmap(MAIL_CAPS, [
      [
        "Mailbox/query",
        { accountId: acct, filter: { role: "drafts" } },
        "mq",
      ] as unknown as JmapInvocation,
    ]);
    const draftMailboxId = (
      (mbResp.methodResponses[0]?.[1]?.ids ?? []) as string[]
    )[0];
    if (!draftMailboxId) throw new Error("No Drafts mailbox found");

    // Create the draft, then submit it. Chained via a back-reference (#).
    const sendResp = await this.jmap(SUBMIT_CAPS, [
      [
        "Email/set",
        {
          accountId: acct,
          create: {
            draft: {
              mailboxIds: { [draftMailboxId]: true },
              keywords: { $draft: true },
              from: [{ email: fromAddr }],
              to: [{ email: replyTo }],
              subject,
              // inReplyTo holds the parent's RFC822 Message-ID header(s), not
              // the JMAP object id, so receiving clients thread the reply.
              ...(latest?.messageId?.length
                ? { inReplyTo: latest.messageId }
                : {}),
              textBody: [{ partId: "body", type: "text/plain" }],
              bodyValues: { body: { value: body } },
            },
          },
        },
        "set",
      ] as unknown as JmapInvocation,
      [
        "EmailSubmission/set",
        {
          accountId: acct,
          onSuccessDestroyEmail: null,
          create: {
            sub: {
              emailId: "#draft",
              envelope: {
                mailFrom: { email: fromAddr },
                rcptTo: [{ email: replyTo }],
              },
            },
          },
        },
        "sub",
      ] as unknown as JmapInvocation,
    ]);

    const submission = sendResp.methodResponses.find(
      (m) => m[0] === "EmailSubmission/set"
    );
    const notCreated = submission?.[1]?.notCreated as
      | Record<string, unknown>
      | undefined;
    if (notCreated && Object.keys(notCreated).length > 0) {
      throw new Error(`Stalwart send failed: ${JSON.stringify(notCreated)}`);
    }
  }

  /**
   * Parse a JMAP push (RFC 8030 StateChange) delivered to our webhook. The
   * push carries only changed type-state, not content, so we fetch the newest
   * email and emit a fully-populated message.created event. Returns null when
   * the payload isn't an Email state change (nothing actionable).
   */
  async parseWebhook(
    _headers: Record<string, string>,
    rawBody: string | Buffer
  ): Promise<WebhookEvent | null> {
    if (!this.isConfigured()) return null;
    let payload: { changed?: Record<string, Record<string, string>> };
    try {
      payload = JSON.parse(rawBody.toString());
    } catch {
      return null;
    }
    const { accountId } = await this.getSession();
    const changedForAccount = payload.changed?.[accountId];
    // Only act on Email-type state changes.
    if (!changedForAccount || !("Email" in changedForAccount)) return null;

    // Fetch the newest email and emit it as a message.created event.
    const queryResp = await this.jmap(MAIL_CAPS, [
      [
        "Email/query",
        {
          accountId,
          sort: [{ property: "receivedAt", isAscending: false }],
          limit: 1,
        },
        "q",
      ] as unknown as JmapInvocation,
    ]);
    const ids = (queryResp.methodResponses[0]?.[1]?.ids ?? []) as string[];
    const [email] = await this.fetchEmails(ids, accountId);
    if (!email) return null;

    const sender = email.from?.[0];
    return {
      type: "message.created",
      accountExternalId: accountId,
      provider: "stalwart",
      threadId: email.threadId ?? email.id,
      message: {
        externalMessageId: email.id,
        threadId: email.threadId ?? email.id,
        senderName: sender?.name ?? sender?.email ?? "(unknown)",
        body: StalwartConnector.bodyText(email),
        sentAt: email.receivedAt ?? new Date(0).toISOString(),
        direction: "inbound",
      },
    };
  }

  /** Account lifecycle is owned by Eve provisioning, not this connector. */
  async deleteAccount(): Promise<void> {
    throw new Error("Stalwart accounts are managed by Eve, not the connector.");
  }

  /** Register a JMAP PushSubscription so new-mail events reach our webhook. */
  async ensureWebhooksRegistered(publicUrl: string): Promise<void> {
    if (!this.isConfigured()) return;
    const { accountId } = await this.getSession();
    await this.jmap(MAIL_CAPS, [
      [
        "PushSubscription/set",
        {
          create: {
            synap: {
              deviceClientId: `synap-${accountId}`,
              url: `${publicUrl.replace(/\/$/, "")}/webhooks/messaging`,
              types: ["Email"],
            },
          },
        },
        "ps",
      ] as unknown as JmapInvocation,
    ]);
    // Errors propagate: a failed PushSubscription means inbound new-mail events
    // won't arrive, which the caller (account sync) should surface — not swallow.
  }
}
