/**
 * THE RECIPIENT OF AN INTENT ACTION — the person or company a pod app names
 * in its input `to` (an entity id), and the addresses the pod finds for them
 * (CRM consolidation plan, Lane 2; founder 2026-10-28: the POD resolves the
 * recipient, the POD ranks channels).
 *
 * The app sends an entity id and never learns a provider id. A verb's input
 * map reads `$to.<address>` (`intent-input.ts`); this module answers each
 * address for the account the action targets, from what the pod already
 * holds and nothing else:
 *
 *   email, phone              the entity's `email` / `phone` property
 *   linkedin.providerId       its `linkedinProviderId` property (written by
 *                             the LinkedIn capture verbs)
 *   linkedin.publicIdentifier its `publicIdentifier` property, else the slug
 *                             of its `linkedinUrl` (linkedin.com/in/<slug>)
 *   chat                      the newest EXTERNAL channel bound to the entity
 *                             (`contextObjectType` entity) on the action's
 *                             account (`metadata.accountId` = `$account.id`;
 *                             with no account, the channel's provider = the
 *                             action's provider)
 *   attendee                  that chat's `metadata.participantExternalId`,
 *                             else the property `<provider>ProviderId`
 *                             (`linkedinProviderId` for a LinkedIn account)
 *
 * Kind-blind: a company is reached only through the addresses it carries
 * itself (a shared inbox, its own chat). The pod never picks a person at a
 * company; the app names the person.
 *
 * READ FLOOR. The recipient is read through the entity's registered floor
 * under the request's key grant (`scopedDb`, `grantReadPredicate`): an app
 * names only someone its grant lets it read. The chats and the past touches
 * read next are the person's own rows; they decide an address and an order,
 * and are never returned to the app.
 */
import {
  db,
  and,
  eq,
  isNull,
  isNotNull,
  channels,
  entities,
  relations,
  ChannelType,
} from "@synap/database";
import { humanizeToken } from "@synap-core/types/vocabulary";
import { AccessContext } from "../../access/context.js";
import { scopedDb } from "../../access/scoped-db.js";
import type {
  IntentAccount,
  RecipientAddress,
  RecipientAddresses,
} from "./intent-input.js";

/** A conversation the pod holds with the recipient (an EXTERNAL channel). */
export interface RecipientConversation {
  provider: string | null;
  accountId: string | null;
  chatId: string;
  participantId: string | null;
  /** Its last message, epoch ms. */
  at: number;
}

/** A message sent to the recipient before (a touch `sent_to` them). */
export interface RecipientTouch {
  /** The channel it went through (`linkedin`, `email`…), lower-cased. */
  channel: string;
  at: number;
}

export interface IntentRecipient {
  id: string;
  /** How the person's review names them. */
  name: string;
  properties: Record<string, unknown>;
  conversations: RecipientConversation[];
  touches: RecipientTouch[];
}

/** The account and provider one action reaches. */
export interface RecipientTarget {
  account: IntentAccount | null;
  provider: string | null;
}

/**
 * A past message counts toward "the channel last used" once it left the
 * drafts: the `sent_to` edge of a touch (CRM's outreach-touch) that has a
 * status past `drafted`, through the `channel` it names.
 */
const SENT_TO = "sent_to";
const NOT_SENT_STATUSES = new Set(["drafted"]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

const timeOf = (v: unknown, fallback: Date | null): number => {
  const parsed = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(parsed) ? parsed : (fallback?.getTime() ?? 0);
};

const lower = (v: string | null | undefined) => (v ? v.toLowerCase() : null);

/**
 * The recipient the caller may read, with what the pod knows of how to reach
 * them; null when the id names nothing the caller may read (absent, deleted,
 * outside the key's grant — one answer, so an app cannot probe for ids).
 */
export async function loadRecipient(
  ctx: { userId: string; agentUserId: string | null },
  entityId: string
): Promise<IntentRecipient | null> {
  if (!UUID_RE.test(entityId)) return null;
  const entity = await scopedDb(
    AccessContext.agent({ userId: ctx.userId, agentUserId: ctx.agentUserId })
  ).findFirst<{
    id: string;
    title: string | null;
    properties: unknown;
  }>(entities, {
    columns: { id: true, title: true, properties: true },
    where: and(eq(entities.id, entityId), isNull(entities.deletedAt)),
  });
  if (!entity) return null;

  const chats = await db
    .select({
      provider: channels.externalSource,
      chatId: channels.externalChannelId,
      metadata: channels.metadata,
      updatedAt: channels.updatedAt,
    })
    .from(channels)
    .where(
      and(
        eq(channels.channelType, ChannelType.EXTERNAL),
        eq(channels.contextObjectType, "entity"),
        eq(channels.contextObjectId, entity.id),
        eq(channels.userId, ctx.userId),
        isNotNull(channels.externalChannelId)
      )
    );
  const conversations = chats
    .map((c): RecipientConversation => {
      const meta = isRecord(c.metadata) ? c.metadata : {};
      return {
        provider: c.provider,
        accountId: text(meta.accountId),
        chatId: c.chatId!,
        participantId: text(meta.participantExternalId),
        at: timeOf(meta.lastMessageAt, c.updatedAt),
      };
    })
    .sort((a, b) => b.at - a.at);

  const sent = await db
    .select({
      status: entities.status,
      properties: entities.properties,
      updatedAt: entities.updatedAt,
    })
    .from(relations)
    .innerJoin(entities, eq(entities.id, relations.sourceEntityId))
    .where(
      and(
        eq(relations.targetEntityId, entity.id),
        eq(relations.type, SENT_TO),
        eq(entities.userId, ctx.userId),
        isNull(entities.deletedAt)
      )
    );
  const touches: RecipientTouch[] = [];
  for (const t of sent) {
    const props = isRecord(t.properties) ? t.properties : {};
    const status = text(t.status) ?? text(props.status);
    const channel = lower(text(props.channel));
    if (!status || NOT_SENT_STATUSES.has(status) || !channel) continue;
    touches.push({ channel, at: timeOf(props.sentDate, t.updatedAt) });
  }

  const properties = isRecord(entity.properties) ? entity.properties : {};
  return {
    id: entity.id,
    name: text(entity.title) ?? "this person",
    properties,
    conversations,
    touches,
  };
}

/** The provider an action reaches: its account's, else its tool's. */
const targetProvider = (target: RecipientTarget) =>
  lower(target.account?.provider ?? target.provider);

/** Is this conversation on the account (or, with none, the provider) the action reaches? */
function onTarget(c: RecipientConversation, target: RecipientTarget): boolean {
  if (target.account) return c.accountId === target.account.id;
  const provider = targetProvider(target);
  return !!provider && lower(c.provider) === provider;
}

/** The provider key of a `<provider>ProviderId` property: `LINKEDIN` → `linkedin`. */
const providerKey = (provider: string) =>
  provider.toLowerCase().replace(/[^a-z0-9]/g, "");

function linkedinSlug(url: unknown): string | null {
  const raw = text(url);
  if (!raw) return null;
  const m = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(raw);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

/** The account in the person's words, for a `why`. */
function accountWords(target: RecipientTarget): string {
  if (target.account?.label) return target.account.label;
  const provider = target.account?.provider ?? target.provider;
  return provider ? humanizeToken(provider) : "this account";
}

/** One address, or the plain sentence saying why the pod has none. */
function resolveAddress(
  r: IntentRecipient,
  address: RecipientAddress,
  target: RecipientTarget
): { value: string } | { why: string } {
  const p = r.properties;
  const found = (value: string | null, why: string) =>
    value ? { value } : { why };
  const chat = r.conversations.find((c) => onTarget(c, target)) ?? null;
  switch (address) {
    case "email":
      return found(
        text(p.email)?.includes("@") ? text(p.email) : null,
        `No email on file for ${r.name}.`
      );
    case "phone":
      return found(text(p.phone), `No phone number on file for ${r.name}.`);
    case "linkedin.providerId":
      return found(
        text(p.linkedinProviderId),
        `No LinkedIn id on file for ${r.name}.`
      );
    case "linkedin.publicIdentifier":
      return found(
        text(p.publicIdentifier) ?? linkedinSlug(p.linkedinUrl),
        `No LinkedIn profile on file for ${r.name}.`
      );
    case "chat":
      return found(
        chat?.chatId ?? null,
        `No conversation with ${r.name} on ${accountWords(target)} yet.`
      );
    case "attendee": {
      const provider = target.account?.provider ?? target.provider;
      const property = provider ? `${providerKey(provider)}ProviderId` : null;
      return found(
        chat?.participantId ?? (property ? text(p[property]) : null),
        provider
          ? `No ${humanizeToken(provider)} id on file for ${r.name}.`
          : `No id for ${r.name} on ${accountWords(target)}.`
      );
    }
  }
}

/**
 * Every address a map reads, for one action's account — or the first one the
 * pod does not have, as one plain sentence (`reach.why`).
 */
export function resolveRecipient(
  r: IntentRecipient,
  addresses: readonly RecipientAddress[],
  target: RecipientTarget
): { ok: true; addresses: RecipientAddresses } | { ok: false; why: string } {
  const out: RecipientAddresses = {};
  for (const address of addresses) {
    const resolved = resolveAddress(r, address, target);
    if ("why" in resolved) return { ok: false, why: resolved.why };
    out[address] = resolved.value;
  }
  return { ok: true, addresses: out };
}

/**
 * When the person last reached the recipient through this action's channel
 * (epoch ms), or null: their newest conversation on the action's account,
 * or a sent touch whose channel is the action's provider or an address kind
 * its map reads (`email`, `phone`).
 */
export function lastUsedWith(
  r: IntentRecipient,
  addresses: readonly RecipientAddress[],
  target: RecipientTarget
): number | null {
  let last: number | null = null;
  const seen = (at: number) => {
    if (last === null || at > last) last = at;
  };
  for (const c of r.conversations) if (onTarget(c, target)) seen(c.at);
  const provider = targetProvider(target);
  for (const t of r.touches)
    if (
      t.channel === provider ||
      (addresses as readonly string[]).includes(t.channel)
    )
      seen(t.at);
  return last;
}
