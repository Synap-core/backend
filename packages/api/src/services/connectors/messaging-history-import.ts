/**
 * History import: a connected account's past conversations with people
 * ALREADY in the pod land in each person's channel, silently (founder
 * decision 4, channels design §7). The pg-boss job `messaging-history-import`
 * runs it; it is asked for when an account connects (`account.created`), by
 * the owner (`POST /messaging/accounts/{id}/import-history`), and when a
 * person's channel is opened (`openPersonChannel`).
 *
 * Replaces `run-linkedin-backfill.ts` and its one-shot script, which ran the
 * capability verbs as the owner, read only the first page of each chat,
 * imported EVERY chat (people the pod does not know included) and hashed
 * thread + time + body (so the webhook's copy of a message landed twice).
 *
 *   - Pages through the account's chats (`getConversations`) and each chat's
 *     messages (`getMessagesPage`, newest first), at most 500 messages a chat.
 *   - A chat is imported only when its counterpart resolves to a person in the
 *     pod (participant-lookup.ts: external id, then one profile lookup within
 *     the daily budget). Others are skipped; no person is ever created.
 *   - Each message goes through `recordInboundMessage` with the webhook's seed
 *     `${chatId}:${messageId}` and its direction, `suppressSideEffects`: a
 *     message both paths see lands once, and the import fires no automation.
 *   - About one provider request a second. Progress is kept on the account
 *     (`messaging_accounts.metadata.historyImport`): when the lookup budget is
 *     spent the run pauses and resumes the next day from its page; a long run
 *     hands over to a fresh job every few minutes.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  isNull,
  drizzleSql,
  entities,
  messagingAccounts,
  workspaces,
} from "@synap/database";
import { getBoss } from "@synap/events";
import {
  MESSAGING_HISTORY_IMPORT_QUEUE,
  type MessagingHistoryImportJobData,
} from "@synap/jobs/workers/messaging-sync.js";
import { getMessagingConnector } from "../../connectors/index.js";
import type { MessagingConnector } from "../../connectors/MessagingConnector.js";
import { MessagingAccountService } from "../messaging-account-service.js";
import { recordInboundMessage } from "./inbound-recorder.js";
import {
  providerIdProperty,
  recordProviderId,
  resolveParticipant,
  takeProfileLookup,
} from "./participant-lookup.js";

const logger = createLogger({ module: "messaging-history-import" });

/** Messages imported from one chat, newest first. */
export const HISTORY_MAX_MESSAGES_PER_CHAT = 500;
/** Pause between two provider requests (~1 request a second). */
export const HISTORY_REQUEST_GAP_MS = 1000;
/** A run hands over to a fresh job after this long (pg-boss expiry is 15 min). */
export const HISTORY_RUN_BUDGET_MS = 10 * 60 * 1000;
/** Bound on chat pages, against a cursor that never ends. */
const MAX_CHAT_PAGES = 200;

export type MessagingHistoryImportInput = MessagingHistoryImportJobData;

export interface MessagingHistoryImportResult {
  status: "done" | "paused" | "continued" | "skipped";
  reason?: string;
  chatsSeen: number;
  chatsImported: number;
  messagesRecorded: number;
}

/** `messaging_accounts.metadata.historyImport` (whole-account runs only). */
export interface HistoryImportState {
  status: "running" | "paused" | "done";
  /** The chat page to start from (null = the first page). */
  cursor: string | null;
  updatedAt: string;
  chatsImported: number;
  messagesRecorded: number;
  /** Why it paused (`no-budget`). */
  reason?: string;
}

export interface MessagingHistoryImportDeps {
  connector?: MessagingConnector | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Queue a later run (resume tomorrow, or hand over). */
  enqueue?: (
    data: MessagingHistoryImportJobData,
    startAfterSeconds: number
  ) => Promise<void>;
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function enqueueImport(
  data: MessagingHistoryImportJobData,
  startAfterSeconds: number
): Promise<void> {
  await getBoss().send(MESSAGING_HISTORY_IMPORT_QUEUE, data, {
    startAfter: Math.max(1, Math.round(startAfterSeconds)),
    singletonKey: `${data.accountExternalId}:${data.entityId ?? "all"}`,
  });
}

/** Seconds from `now` to the next UTC midnight plus a few minutes. */
function secondsUntilTomorrow(now: Date): number {
  const next = new Date(now);
  next.setUTCHours(24, 5, 0, 0);
  return (next.getTime() - now.getTime()) / 1000;
}

/**
 * The workspace a NEW channel from this account is pinned to: the account's
 * own pin, else the owner's first workspace (the webhook's rule, so both paths
 * create the same channel the same way).
 */
export async function accountHomeWorkspace(account: {
  workspaceId: string | null;
  userId: string;
}): Promise<string | null> {
  if (account.workspaceId) return account.workspaceId;
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.ownerId, account.userId),
    columns: { id: true },
  });
  return ws?.id ?? null;
}

async function saveState(
  accountRowId: string,
  state: HistoryImportState
): Promise<void> {
  await db
    .update(messagingAccounts)
    .set({
      metadata: drizzleSql`jsonb_set(COALESCE(${messagingAccounts.metadata}, '{}'::jsonb), '{historyImport}', ${JSON.stringify(
        state
      )}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(messagingAccounts.id, accountRowId));
}

/** The account row, synced from the provider when the pod has none yet. */
async function loadAccount(
  connector: MessagingConnector,
  userId: string,
  accountExternalId: string
) {
  const find = () =>
    db.query.messagingAccounts.findFirst({
      where: and(
        eq(messagingAccounts.userId, userId),
        eq(messagingAccounts.externalId, accountExternalId)
      ),
    });
  const row = await find();
  if (row) return row;
  // A capability-connected account the pod never mirrored (what the old
  // backfill upserted). A failed read throws: it is not "no such account".
  const live = (await connector.getAccounts(userId)).find(
    (a) => a.externalId === accountExternalId
  );
  if (!live) return undefined;
  await MessagingAccountService.upsert({
    userId,
    provider: live.provider,
    externalId: live.externalId,
    displayName: live.displayName,
    status: live.status,
  });
  return find();
}

/**
 * The provider id of the ONE person a targeted import is for: their stored id,
 * else (LinkedIn) one lookup of their profile slug within the budget.
 * `null` with `noBudget` = try again tomorrow.
 */
async function targetProviderId(args: {
  entityId: string;
  userId: string;
  provider: string;
  account: { id: string; externalId: string };
  connector: MessagingConnector;
  now: Date;
}): Promise<{ providerId: string | null; noBudget?: boolean }> {
  const person = await db.query.entities.findFirst({
    where: and(eq(entities.id, args.entityId), isNull(entities.deletedAt)),
    columns: { properties: true },
  });
  if (!person) return { providerId: null };
  const props = (person.properties ?? {}) as Record<string, unknown>;
  const key = providerIdProperty(args.provider);
  const stored = key ? props[key] : undefined;
  if (typeof stored === "string" && stored.trim()) {
    return { providerId: stored.trim() };
  }
  if (args.provider !== "linkedin" || !args.connector.getProfile) {
    return { providerId: null };
  }
  const url = props.linkedinUrl ?? props["linkedin-url"];
  const slug =
    typeof url === "string"
      ? /linkedin\.com\/in\/([^/?#]+)/i.exec(url)?.[1]
      : undefined;
  if (!slug) return { providerId: null };
  if (!(await takeProfileLookup(args.account.id, args.now))) {
    return { providerId: null, noBudget: true };
  }
  const profile = await args.connector.getProfile(
    args.account.externalId,
    decodeURIComponent(slug)
  );
  if (!profile?.providerId) return { providerId: null };
  // The profile answered for this person's own URL: the id is theirs.
  await recordProviderId({
    entityId: args.entityId,
    userId: args.userId,
    provider: args.provider,
    providerId: profile.providerId,
  });
  return { providerId: profile.providerId };
}

/** See the module doc. */
export async function runMessagingHistoryImport(
  input: MessagingHistoryImportInput,
  deps: MessagingHistoryImportDeps = {}
): Promise<MessagingHistoryImportResult> {
  const result: MessagingHistoryImportResult = {
    status: "done",
    chatsSeen: 0,
    chatsImported: 0,
    messagesRecorded: 0,
  };
  const skipped = (reason: string): MessagingHistoryImportResult => ({
    ...result,
    status: "skipped",
    reason,
  });
  if (!input?.accountExternalId || !input?.userId) {
    return skipped("missing_account_or_user");
  }

  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? (() => new Date());
  const enqueue = deps.enqueue ?? enqueueImport;
  const startedAt = now().getTime();

  const connector =
    deps.connector !== undefined
      ? deps.connector
      : await getMessagingConnector();
  if (!connector) return skipped("messaging_not_configured");
  if (!connector.getMessagesPage) return skipped("connector_cannot_page");

  const account = await loadAccount(
    connector,
    input.userId,
    input.accountExternalId
  );
  if (!account) return skipped("no_such_account");
  const provider = account.provider.toLowerCase();
  const accountRef = { id: account.id, externalId: account.externalId };
  const workspaceId = await accountHomeWorkspace(account);
  const wholeAccount = !input.entityId;

  // A targeted import (one person) scans for that person's chats only.
  let onlyProviderId: string | null = null;
  if (input.entityId) {
    const target = await targetProviderId({
      entityId: input.entityId,
      userId: input.userId,
      provider,
      account: accountRef,
      connector,
      now: now(),
    });
    if (target.noBudget) {
      await enqueue(input, secondsUntilTomorrow(now()));
      return { ...result, status: "paused", reason: "no-budget" };
    }
    if (!target.providerId) return skipped("person_has_no_provider_id");
    onlyProviderId = target.providerId;
  }

  const prior = (account.metadata as Record<string, unknown> | null)
    ?.historyImport as HistoryImportState | undefined;
  let cursor: string | undefined =
    input.cursor ??
    (wholeAccount && prior && prior.status !== "done"
      ? (prior.cursor ?? undefined)
      : undefined);
  const counts = () => ({
    chatsImported: result.chatsImported,
    messagesRecorded: result.messagesRecorded,
  });
  const save = async (state: Omit<HistoryImportState, "updatedAt">) => {
    if (!wholeAccount) return;
    await saveState(account.id, { ...state, updatedAt: now().toISOString() });
  };

  await save({ status: "running", cursor: cursor ?? null, ...counts() });

  for (let page = 0; page < MAX_CHAT_PAGES; page += 1) {
    const pageCursor = cursor;
    const chats = await connector.getConversations(account.externalId, cursor);
    await sleep(HISTORY_REQUEST_GAP_MS);

    for (const chat of chats.items) {
      const counterpart = chat.participantExternalId?.trim();
      if (!counterpart) continue;
      result.chatsSeen += 1;
      if (onlyProviderId && counterpart !== onlyProviderId) continue;

      let entityId: string | null = input.entityId ?? null;
      if (!entityId) {
        const who = await resolveParticipant({
          provider,
          userId: input.userId,
          account: accountRef,
          providerId: counterpart,
          chatId: chat.externalThreadId,
          connector,
          now: now(),
        });
        if (who.lookup) await sleep(HISTORY_REQUEST_GAP_MS);
        if (who.lookup?.result === "no-budget") {
          // Spent for today: resume from this page tomorrow (what already
          // landed dedups on the second pass).
          await save({
            status: "paused",
            cursor: pageCursor ?? null,
            reason: "no-budget",
            ...counts(),
          });
          await enqueue(
            { ...input, cursor: pageCursor },
            secondsUntilTomorrow(now())
          );
          return { ...result, status: "paused", reason: "no-budget" };
        }
        entityId = who.entityId;
      }
      if (!entityId) continue;

      result.chatsImported += 1;
      let msgCursor: string | undefined;
      let taken = 0;
      do {
        const msgPage = await connector.getMessagesPage(
          account.externalId,
          chat.externalThreadId,
          msgCursor
        );
        await sleep(HISTORY_REQUEST_GAP_MS);
        for (const m of msgPage.messages) {
          if (taken >= HISTORY_MAX_MESSAGES_PER_CHAT) break;
          taken += 1;
          if (!m.body?.trim() || !m.externalMessageId) continue;
          const rec = await recordInboundMessage({
            provider,
            externalId: chat.externalThreadId,
            userId: input.userId,
            workspaceId,
            text: m.body,
            participant: chat.participantName,
            participantExternalId: counterpart,
            accountExternalId: account.externalId,
            title: chat.participantName,
            idempotencySeed: `${chat.externalThreadId}:${m.externalMessageId}`,
            messageId: m.externalMessageId,
            sentAt: m.sentAt,
            direction: m.direction,
            contextEntityId: entityId,
            // History, not news: no automation, no webhook fan-out.
            suppressSideEffects: true,
            origin: {
              producerType: "source",
              producerId: provider,
              producerName: `${provider} (Unipile)`,
            },
          });
          if (rec.recorded) result.messagesRecorded += 1;
        }
        msgCursor = msgPage.nextCursor || undefined;
      } while (msgCursor && taken < HISTORY_MAX_MESSAGES_PER_CHAT);

      // A targeted import is about one person's chat: done once found.
      if (onlyProviderId) return result;
    }

    const next = chats.nextCursor?.trim() || undefined;
    if (!next || next === cursor) break;
    cursor = next;
    await save({ status: "running", cursor, ...counts() });

    if (now().getTime() - startedAt > HISTORY_RUN_BUDGET_MS) {
      await enqueue({ ...input, cursor }, 1);
      return { ...result, status: "continued" };
    }
  }

  await save({ status: "done", cursor: null, ...counts() });
  logger.info(
    { accountExternalId: account.externalId, ...result },
    "messaging history import complete"
  );
  return result;
}
