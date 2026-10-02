/**
 * LinkedIn conversation backfill — surfaces a connected LinkedIn account's
 * existing conversations as Synap EXTERNAL channels (exactly like the Discord
 * bridge / the Unipile `/messaging` webhook), for accounts that were connected
 * through the CAPABILITY install rather than the legacy messaging connector.
 *
 * Mirrors the proven poller pattern of `runCalBackfill` / `runGcalImport`:
 *   - lists via the in-process capability executor as the OWNER (userId set, NO
 *     agentUserId → owner-bypasses the capability gate, same as runCalBackfill),
 *   - feeds every message into the ONE idempotent sink `recordInboundMessage`
 *     (sha256 guard over `${provider}:${idempotencySeed}`), so re-runs are safe
 *     and the same channel/dedup semantics the webhook uses apply verbatim.
 *
 * It also UPSERTS a `messaging_accounts` row for the account (with the workspace
 * pin) BEFORE recording — the capability install does NOT persist to
 * messaging_accounts today, so without this the inbound `/messaging` webhook
 * could not later resolve this account. Provider is `"linkedin"` to match what
 * `UnipileConnector.parseWebhook` reports (`mapProviderType('LINKEDIN')`), which
 * is the key the webhook looks the row up by.
 *
 * Verb param names + result shapes come from the unipile-linkedin capability
 * template (control plane): `unipile_list_conversations` takes { accountId,
 * cursor? } and returns { conversations, cursor }; `unipile_list_messages` takes
 * { threadId, accountId } and returns { messages, cursor }. (These are the
 * DECLARATIVE param names — camelCase — not `account_id`.)
 */

import { createLogger } from "@synap-core/core";
import { executeCapability } from "../capabilities/execute-capability.js";
import { recordInboundMessage } from "./inbound-recorder.js";
import { MessagingAccountService } from "../messaging-account-service.js";

const logger = createLogger({ module: "linkedin-backfill" });

/** LinkedIn provider key — matches UnipileConnector.parseWebhook's mapped value. */
const LINKEDIN_PROVIDER = "linkedin";

/**
 * Safety cap on conversation pages. The declarative list verb returns 25 chats
 * per page; this bounds a runaway/looping cursor (and covers the realistic case
 * where the cursor never advances) without ever hanging the pod.
 */
const MAX_CONVERSATION_PAGES = 200;

export interface RunLinkedInBackfillInput {
  /** Unipile connected-account id (the capability's `accountId`). */
  accountId: string;
  /** The pod owner acting identity (owner-bypasses the capability gate). */
  userId: string;
  /** Workspace the recorded channels/messages are pinned to. */
  workspaceId: string | null;
}

export interface RunLinkedInBackfillResult {
  skipped?: boolean;
  reason?: string;
  threadsSeen: number;
  messagesRecorded: number;
}

// ── defensive field extraction (raw Unipile v2 objects — no `item` map) ────────

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

/** Thread id off a raw v2 chat object. */
function chatId(chat: Record<string, unknown>): string | undefined {
  return firstString(chat.id, chat.chat_id, chat.thread_id);
}

/** Best-effort attendee display name off a raw v2 chat object. */
function chatAttendeeName(chat: Record<string, unknown>): string | undefined {
  const attendees = chat.attendees;
  if (Array.isArray(attendees) && attendees.length > 0) {
    const a = attendees[0] as Record<string, unknown>;
    const n = firstString(a?.name, a?.display_name, a?.username);
    if (n) return n;
  }
  return firstString(chat.name, chat.subject, chat.title);
}

/** Message body off a raw v2 message object. */
function messageBody(msg: Record<string, unknown>): string {
  return firstString(msg.text, msg.body, msg.message, msg.content) ?? "";
}

/** Sender display name off a raw v2 message object. */
function messageSenderName(msg: Record<string, unknown>): string | undefined {
  const from = msg.from as Record<string, unknown> | undefined;
  return firstString(
    msg.sender_name,
    msg.author_name,
    from?.name,
    msg.sender_id
  );
}

/** ISO timestamp off a raw v2 message object; defaults to now. */
function messageSentAt(msg: Record<string, unknown>): string {
  return (
    firstString(msg.timestamp, msg.created_at, msg.date, msg.sent_at) ??
    new Date().toISOString()
  );
}

// ── main ────────────────────────────────────────────────────────────────────

/**
 * Backfill every conversation on `accountId` into Synap EXTERNAL channels.
 * Idempotent end-to-end (safe to re-run). Never throws on a single-thread/message
 * failure — logs and continues so one bad thread can't abort the whole run.
 */
export async function runLinkedInBackfill(
  input: RunLinkedInBackfillInput
): Promise<RunLinkedInBackfillResult> {
  const { accountId, userId, workspaceId } = input;

  if (!accountId || !userId) {
    return {
      skipped: true,
      reason: "missing_accountId_or_userId",
      threadsSeen: 0,
      messagesRecorded: 0,
    };
  }

  // Resolve a display name best-effort (nice UI label) from the account list.
  let displayName = accountId;
  try {
    const accountsCap = await executeCapability({
      verbId: "unipile_list_accounts",
      parameters: {},
      userId,
      workspaceId,
    });
    if (accountsCap.kind === "run") {
      const accounts =
        (accountsCap.result as { accounts?: Record<string, unknown>[] })
          ?.accounts ?? [];
      const match = accounts.find(
        (a) => firstString(a?.id, a?.account_id) === accountId
      );
      if (match) {
        displayName =
          firstString(match.name, match.display_name, match.username) ??
          accountId;
      }
    }
  } catch (err) {
    logger.warn(
      { err, accountId },
      "linkedin backfill: account list failed (using id as label)"
    );
  }

  // Persist the messaging_accounts row (with the workspace pin) BEFORE recording,
  // so the inbound webhook can later resolve THIS capability-connected account.
  await MessagingAccountService.upsert({
    userId,
    provider: LINKEDIN_PROVIDER,
    externalId: accountId,
    displayName,
    status: "connected",
    workspaceId,
  }).catch((err) =>
    logger.warn(
      { err, accountId },
      "linkedin backfill: messaging_accounts upsert failed (continuing — recording still works)"
    )
  );

  let threadsSeen = 0;
  let messagesRecorded = 0;
  let cursor: string | undefined;
  let page = 0;

  do {
    const convCap = await executeCapability({
      verbId: "unipile_list_conversations",
      parameters: cursor ? { accountId, cursor } : { accountId },
      userId,
      workspaceId,
    });

    if (convCap.kind !== "run") {
      logger.warn(
        { capKind: convCap.kind, accountId, page },
        "unipile_list_conversations did not run — stopping backfill"
      );
      if (page === 0) {
        return {
          skipped: true,
          reason: `list_conversations_${convCap.kind}`,
          threadsSeen,
          messagesRecorded,
        };
      }
      break;
    }

    const convResult = convCap.result as {
      conversations?: Record<string, unknown>[];
      cursor?: string | null;
    };
    const conversations = Array.isArray(convResult?.conversations)
      ? convResult.conversations
      : [];

    for (const chat of conversations) {
      const threadId = chatId(chat);
      if (!threadId) continue;
      threadsSeen += 1;
      const attendeeName = chatAttendeeName(chat);

      try {
        const msgCap = await executeCapability({
          verbId: "unipile_list_messages",
          parameters: { threadId, accountId },
          userId,
          workspaceId,
        });
        if (msgCap.kind !== "run") {
          logger.warn(
            { capKind: msgCap.kind, threadId },
            "unipile_list_messages did not run — skipping thread"
          );
          continue;
        }
        const msgResult = msgCap.result as {
          messages?: Record<string, unknown>[];
        };
        const rawMessages = Array.isArray(msgResult?.messages)
          ? msgResult.messages
          : [];

        for (const msg of rawMessages) {
          const body = messageBody(msg);
          // A message with no text carries nothing to record and would hash on an
          // empty seed; skip it. (This is NOT an is_sender filter — the recorder
          // records EXTERNAL regardless of direction.)
          if (!body.trim()) continue;
          const sentAt = messageSentAt(msg);
          const senderName = messageSenderName(msg);

          const res = await recordInboundMessage({
            provider: LINKEDIN_PROVIDER,
            externalId: threadId,
            userId,
            workspaceId,
            text: body,
            participant: senderName ?? attendeeName,
            accountExternalId: accountId,
            title: attendeeName ?? senderName ?? threadId,
            idempotencySeed: `${threadId}:${sentAt}:${body}`,
            sentAt,
          });
          if (res.recorded) messagesRecorded += 1;
        }
      } catch (err) {
        logger.warn(
          { err, threadId },
          "linkedin backfill: thread → messages failed (continuing)"
        );
      }
    }

    // Pagination: the conversations verb exposes a `cursor` param + surfaces the
    // provider's next cursor as `result.cursor`. Loop while it advances; the page
    // cap bounds a stuck cursor. (The messages verb has no cursor param, so each
    // thread is a single page of its most-recent messages.)
    const next =
      typeof convResult?.cursor === "string" && convResult.cursor.trim()
        ? convResult.cursor
        : undefined;
    cursor = next && next !== cursor ? next : undefined;
    page += 1;
  } while (cursor && page < MAX_CONVERSATION_PAGES);

  logger.info(
    { accountId, workspaceId, threadsSeen, messagesRecorded, pages: page },
    "linkedin backfill run complete"
  );
  return { threadsSeen, messagesRecorded };
}
