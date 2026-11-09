/**
 * A space's conversations: every person the caller is reaching out to in
 * one space, in ONE read (CRM Messages contract b4f8c2cd, A; build map
 * ca310f27 slice 1). Hub `GET /channels/conversations`.
 *
 * Who is listed: a person (any record) whom the caller can read, who has an
 * external channel bound to them or an open send (pending, held or failed),
 * and who is a lead of the space in one of two ways (plan 87088d2d W1):
 *   - they wear a live role in the space themselves (a facet stamped there,
 *     or a pod-wide facet whose role is granted to it): `lead.kind` person;
 *   - or they `works_at` (person → company) a company the caller can read
 *     that wears such a role: `lead.kind` company, the company's id. Most
 *     company leads are reached through their contact.
 * A person who is a lead themselves stays `person` even when their company
 * is one too. `lead.stage` is that role's status. One row per person: their
 * name and company, the lead it belongs to, their channel ids, the last
 * message, the draft waiting (or the failed send), unread inbound messages
 * and their LinkedIn reach.
 *
 * Every read carries the caller's floor AND the key's grant, through the
 * existing doors:
 *   - the people: `entityReadVisibleWhere` + `roleInWorkspaceLensWhere`
 *     (a role in THIS space, stamped there or pod-wide and granted to it,
 *     and the caller a member of it), and the
 *     listing rule (`listableEntityWhere`: no probe or demo row);
 *   - their channels: `channelVisibilityWhere` (a channel follows its person);
 *   - their sends: `proposalUserFloor` (floor + `proposal` grant): a key that
 *     cannot read proposals sees no drafts, never someone else's;
 *   - their company, and the lead company that lists them: the same
 *     `entityReadVisibleWhere` + `roleInWorkspaceLensWhere` + listing rule
 *     on the company;
 *   - the lead's stage: `roleFacetInWorkspaceLensWhere`, the facet form of
 *     the same role rule.
 *
 * SET-BASED: a fixed number of queries whatever the number of people (never
 * one per person). Paged by keyset on (last activity, person id), newest
 * first; the cursor is opaque.
 */

import {
  db,
  and,
  desc,
  eq,
  inArray,
  isNull,
  or,
  drizzleSql,
  listableEntityWhere,
  ProposalStatus,
} from "@synap/database";
import {
  channelMembers,
  channels,
  entities,
  entityFacets,
  messages,
  proposals,
  relations,
} from "@synap/database/schema";
import { entityReadVisibleWhere } from "../../access/entity-read-floor.js";
import { channelVisibilityWhere } from "../../utils/channel-visibility.js";
import {
  roleFacetInWorkspaceLensWhere,
  roleInWorkspaceLensWhere,
} from "../../utils/project-scope.js";
import { proposalUserFloor } from "../../routers/proposals/scope-conditions.js";
import { storedLinkedinReach } from "../connectors/linkedin-reach.js";
import {
  PROPOSED_MESSAGE_TYPE,
  proposedMessageState,
  type ProposedMessageState,
} from "./person-channels.js";

export const SPACE_CONVERSATIONS_DEFAULT_LIMIT = 50;
export const SPACE_CONVERSATIONS_MAX_LIMIT = 100;
const LAST_MESSAGE_CHARS = 200;
const FIRST_LINE_CHARS = 160;
const OPEN_SEND_STATUSES: ProposalStatus[] = [
  ProposalStatus.PENDING,
  ProposalStatus.APPROVAL_FAILED,
];

export interface SpaceConversation {
  person: {
    id: string;
    name: string | null;
    company: { id: string; name: string | null } | null;
  };
  /**
   * The lead this person is listed for: themselves (`person`), or the
   * company they work at (`company`, its id). `stage` is that role's status
   * in the space (null when the role has none).
   */
  lead: { kind: "person" | "company"; id: string; stage: string | null };
  channelIds: string[];
  lastMessage: {
    text: string;
    at: string;
    direction: "inbound" | "outbound" | null;
  } | null;
  /** The newest draft waiting (held or not), else the newest failed send. */
  draft: {
    proposalId: string;
    channelId: string | null;
    firstLine: string;
    state: ProposedMessageState;
    reason: string | null;
  } | null;
  unread: number;
  reach: {
    linkedinConnection: "none" | "pending" | "connected" | "ignored" | null;
    linkedinInvitedAt: string | null;
    hasLinkedinUrl: boolean;
    hasProviderId: boolean;
  };
  lastActivityAt: string;
}

export interface SpaceConversationsPage {
  conversations: SpaceConversation[];
  nextCursor: string | null;
}

export type SpaceConversationsResult =
  ({ status: "ok" } & SpaceConversationsPage) | { status: "bad_cursor" };

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

const iso = (d: Date | string): string =>
  d instanceof Date ? d.toISOString() : new Date(d).toISOString();

/** The first non-empty line of a message, bounded. */
export function firstLineOf(body: string): string {
  const line =
    body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return line.length > FIRST_LINE_CHARS
    ? `${line.slice(0, FIRST_LINE_CHARS - 1)}…`
    : line;
}

interface Cursor {
  at: string;
  id: string;
}

export function encodeConversationsCursor(c: Cursor): string {
  return Buffer.from(`${c.at}|${c.id}`, "utf8").toString("base64url");
}

export function decodeConversationsCursor(raw: string): Cursor | null {
  try {
    const [at, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    if (!at || !id || Number.isNaN(Date.parse(at))) return null;
    return { at: new Date(at).toISOString(), id };
  } catch {
    return null;
  }
}

/** Newest first: by last activity, then by person id (both descending). */
const newestFirst = (
  a: { lastActivityAt: string; id: string },
  b: { lastActivityAt: string; id: string }
) =>
  a.lastActivityAt === b.lastActivityAt
    ? a.id < b.id
      ? 1
      : a.id > b.id
        ? -1
        : 0
    : a.lastActivityAt < b.lastActivityAt
      ? 1
      : -1;

const afterCursor = (row: { lastActivityAt: string; id: string }, c: Cursor) =>
  row.lastActivityAt < c.at || (row.lastActivityAt === c.at && row.id < c.id);

/**
 * The conversations of one space for the caller. `needsYou` keeps only the
 * people a draft (held or not), a failed send or an unread message waits on.
 */
export async function listSpaceConversations(
  args: {
    userId: string;
    workspaceId: string;
    needsYou?: boolean;
    cursor?: string | null;
    limit?: number;
  },
  database: typeof db = db
): Promise<SpaceConversationsResult> {
  const { userId, workspaceId } = args;
  const limit = Math.min(
    Math.max(1, args.limit ?? SPACE_CONVERSATIONS_DEFAULT_LIMIT),
    SPACE_CONVERSATIONS_MAX_LIMIT
  );
  const cursor = args.cursor ? decodeConversationsCursor(args.cursor) : null;
  if (args.cursor && !cursor) return { status: "bad_cursor" };

  const personChannelWhere = and(
    eq(channels.channelType, "external"),
    eq(channels.status, "active"),
    eq(channels.contextObjectType, "entity"),
    channelVisibilityWhere(userId)
  );
  const openSendWhere = and(
    eq(proposals.proposalType, PROPOSED_MESSAGE_TYPE),
    inArray(proposals.status, OPEN_SEND_STATUSES),
    proposalUserFloor(userId)
  );

  // 1. The people: readable, a channel or an open send bound to them, and a
  //    lead of the space: a role in it (a facet stamped there, or a pod-wide
  //    facet whose role is granted to it: most leads are pod-wide), or
  //    `works_at` a readable company that has one.
  const withChannel = database
    .select({ id: channels.contextObjectId })
    .from(channels)
    .where(personChannelWhere);
  const withSend = database
    .select({ id: drizzleSql<string>`${proposals.data} ->> 'entityId'` })
    .from(proposals)
    .where(and(openSendWhere, drizzleSql`${proposals.data} ? 'entityId'`));
  const leadCompanyWhere = and(
    isNull(entities.deletedAt),
    roleInWorkspaceLensWhere(
      entities.workspaceId,
      entities.id,
      userId,
      workspaceId
    ),
    entityReadVisibleWhere(userId),
    listableEntityWhere()
  );
  const contactOfLeadCompany = database
    .select({ id: relations.sourceEntityId })
    .from(relations)
    .where(
      and(
        eq(relations.type, "works_at"),
        inArray(
          relations.targetEntityId,
          database
            .select({ id: entities.id })
            .from(entities)
            .where(leadCompanyWhere)
        )
      )
    );
  const people = await database
    .select({
      id: entities.id,
      title: entities.title,
      properties: entities.properties,
    })
    .from(entities)
    .where(
      and(
        isNull(entities.deletedAt),
        or(
          roleInWorkspaceLensWhere(
            entities.workspaceId,
            entities.id,
            userId,
            workspaceId
          ),
          inArray(entities.id, contactOfLeadCompany)
        ),
        entityReadVisibleWhere(userId),
        // THE LISTING RULE (FB1020 B5): no probe-key row, no demo row.
        listableEntityWhere(),
        or(
          inArray(entities.id, withChannel),
          drizzleSql`${entities.id}::text IN (${withSend})`
        )
      )
    );
  if (people.length === 0) {
    return { status: "ok", conversations: [], nextCursor: null };
  }
  const personIds = people.map((p) => p.id);

  // 2. Their channels, 3. their open sends (newest first).
  const chans = await database
    .select({
      id: channels.id,
      entityId: channels.contextObjectId,
      updatedAt: channels.updatedAt,
      metadata: channels.metadata,
    })
    .from(channels)
    .where(
      and(personChannelWhere, inArray(channels.contextObjectId, personIds))
    )
    .orderBy(desc(channels.updatedAt), desc(channels.id));
  const sends = await database
    .select({
      id: proposals.id,
      status: proposals.status,
      data: proposals.data,
      rejectionReason: proposals.rejectionReason,
      createdAt: proposals.createdAt,
    })
    .from(proposals)
    .where(
      and(
        openSendWhere,
        drizzleSql`${proposals.data} ->> 'entityId' IN (${drizzleSql.join(
          personIds.map((id) => drizzleSql`${id}`),
          drizzleSql`, `
        )})`
      )
    )
    .orderBy(desc(proposals.createdAt), desc(proposals.id));

  // 4. The last message of each channel, 5. unread inbound messages. The
  //    channels were admitted by the floor above; the history filters
  //    (deleted, ephemeral) are applied here.
  const channelIds = chans.map((c) => c.id);
  const lastByChannel = new Map<
    string,
    { content: string; timestamp: Date; direction: string | null }
  >();
  const unreadByChannel = new Map<string, number>();
  if (channelIds.length > 0) {
    const last = await database
      .selectDistinctOn([messages.channelId], {
        channelId: messages.channelId,
        content: messages.content,
        timestamp: messages.timestamp,
        direction: messages.direction,
      })
      .from(messages)
      .where(
        and(
          inArray(messages.channelId, channelIds),
          isNull(messages.deletedAt),
          eq(messages.ephemeral, false)
        )
      )
      .orderBy(messages.channelId, desc(messages.timestamp), desc(messages.id));
    for (const m of last) lastByChannel.set(m.channelId, m);

    // Inbound after the latest outbound one and the caller's read marker;
    // none on a channel marked read (person-channels.ts `unreadCount`).
    const unreadChannels = chans
      .filter(
        (c) => ((c.metadata ?? {}) as Record<string, unknown>).unread !== false
      )
      .map((c) => c.id);
    if (unreadChannels.length > 0) {
      const counts = await database
        .select({
          channelId: messages.channelId,
          n: drizzleSql<number>`count(*)::int`,
        })
        .from(messages)
        .where(
          and(
            inArray(messages.channelId, unreadChannels),
            eq(messages.direction, "inbound"),
            isNull(messages.deletedAt),
            eq(messages.ephemeral, false),
            drizzleSql`${messages.timestamp} > COALESCE(GREATEST(
              (SELECT max(o.timestamp) FROM ${messages} o
                WHERE o.channel_id = ${messages.channelId}
                  AND o.direction = 'outbound' AND o.deleted_at IS NULL),
              (SELECT cm.last_read_at FROM ${channelMembers} cm
                WHERE cm.channel_id = ${messages.channelId}
                  AND cm.member_id = ${userId})
            ), '-infinity'::timestamptz)`
          )
        )
        .groupBy(messages.channelId);
      for (const r of counts) unreadByChannel.set(r.channelId, Number(r.n));
    }
  }

  // 6. One row per person.
  const channelsOf = new Map<string, typeof chans>();
  for (const c of chans) {
    if (!c.entityId) continue;
    const list = channelsOf.get(c.entityId) ?? [];
    list.push(c);
    channelsOf.set(c.entityId, list);
  }
  const sendsOf = new Map<string, typeof sends>();
  for (const s of sends) {
    const entityId = str((s.data as Record<string, unknown> | null)?.entityId);
    if (!entityId) continue;
    const list = sendsOf.get(entityId) ?? [];
    list.push(s);
    sendsOf.set(entityId, list);
  }

  const rows = people.map((p) => {
    const own = channelsOf.get(p.id) ?? [];
    let lastMessage: SpaceConversation["lastMessage"] = null;
    let unread = 0;
    for (const c of own) {
      unread += unreadByChannel.get(c.id) ?? 0;
      const m = lastByChannel.get(c.id);
      if (m && (!lastMessage || iso(m.timestamp) > lastMessage.at)) {
        lastMessage = {
          text: m.content.slice(0, LAST_MESSAGE_CHARS),
          at: iso(m.timestamp),
          direction:
            m.direction === "inbound" || m.direction === "outbound"
              ? m.direction
              : null,
        };
      }
    }
    const open = sendsOf.get(p.id) ?? [];
    const pick =
      open.find((s) => s.status === "pending") ??
      open.find((s) => s.status === "approval_failed") ??
      null;
    let draft: SpaceConversation["draft"] = null;
    if (pick) {
      const data = (pick.data ?? {}) as Record<string, unknown>;
      const { state, reason } = proposedMessageState(pick);
      draft = {
        proposalId: pick.id,
        channelId: str(data.channelId),
        firstLine: firstLineOf(
          str(data.body) ?? str(data.content) ?? str(data.text) ?? ""
        ),
        state,
        reason,
      };
    }
    const activity = [
      lastMessage?.at,
      open[0] ? iso(open[0].createdAt) : undefined,
    ].filter((v): v is string => !!v);
    const lastActivityAt =
      activity.sort().at(-1) ??
      (own[0] ? iso(own[0].updatedAt) : new Date(0).toISOString());
    const props = (p.properties ?? {}) as Record<string, unknown>;
    const reach = storedLinkedinReach(props);
    const conversation: SpaceConversation = {
      person: { id: p.id, name: p.title ?? null, company: null },
      lead: { kind: "person", id: p.id, stage: null },
      channelIds: own.map((c) => c.id),
      lastMessage,
      draft,
      unread,
      reach: {
        linkedinConnection: reach?.connection ?? null,
        linkedinInvitedAt: reach?.invitedAt ?? null,
        hasLinkedinUrl: !!(
          str(props.linkedinUrl) ?? str(props.publicIdentifier)
        ),
        hasProviderId: !!str(props.linkedinProviderId),
      },
      lastActivityAt,
    };
    return { id: p.id, lastActivityAt, conversation };
  });

  const listed = rows
    .filter(
      (r) =>
        !args.needsYou ||
        r.conversation.draft !== null ||
        r.conversation.unread > 0
    )
    .filter((r) => !cursor || afterCursor(r, cursor))
    .sort(newestFirst);
  const page = listed.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    listed.length > limit && last
      ? encodeConversationsCursor({ at: last.lastActivityAt, id: last.id })
      : null;

  // 7. The company of each person on the page (`works_at`), when readable,
  // 8. the lead company each of them works at (a role in the space), and
  // 9. the role facets in the space of those people and companies: who the
  //    row's lead is, and its stage.
  if (page.length > 0) {
    const pageIds = page.map((r) => r.id);
    const companies = await database
      .select({
        personId: relations.sourceEntityId,
        id: entities.id,
        name: entities.title,
      })
      .from(relations)
      .innerJoin(entities, eq(entities.id, relations.targetEntityId))
      .where(
        and(
          eq(relations.type, "works_at"),
          inArray(relations.sourceEntityId, pageIds),
          isNull(entities.deletedAt),
          entityReadVisibleWhere(userId)
        )
      )
      .orderBy(desc(relations.createdAt), desc(entities.id));
    const leadCompanies = await database
      .select({
        personId: relations.sourceEntityId,
        id: entities.id,
        name: entities.title,
      })
      .from(relations)
      .innerJoin(entities, eq(entities.id, relations.targetEntityId))
      .where(
        and(
          eq(relations.type, "works_at"),
          inArray(relations.sourceEntityId, pageIds),
          leadCompanyWhere
        )
      )
      .orderBy(desc(relations.createdAt), desc(entities.id));
    const roleHolders = [
      ...new Set([...pageIds, ...leadCompanies.map((c) => c.id)]),
    ];
    // A role's stage: the facet with a status first, then the newest one.
    const roles = await database
      .select({
        entityId: entityFacets.entityId,
        status: entityFacets.status,
      })
      .from(entityFacets)
      .innerJoin(entities, eq(entities.id, entityFacets.entityId))
      .where(
        and(
          inArray(entityFacets.entityId, roleHolders),
          roleFacetInWorkspaceLensWhere(
            entities.workspaceId,
            userId,
            workspaceId
          )
        )
      )
      .orderBy(
        drizzleSql`${entityFacets.status} IS NULL`,
        desc(entityFacets.updatedAt),
        desc(entityFacets.id)
      );
    const roleOf = new Map<string, string | null>();
    for (const f of roles) {
      if (!roleOf.has(f.entityId)) roleOf.set(f.entityId, f.status ?? null);
    }
    for (const r of page) {
      const leadCompany = leadCompanies.find((c) => c.personId === r.id);
      if (roleOf.has(r.id)) {
        r.conversation.lead = {
          kind: "person",
          id: r.id,
          stage: roleOf.get(r.id) ?? null,
        };
      } else if (leadCompany) {
        r.conversation.lead = {
          kind: "company",
          id: leadCompany.id,
          stage: roleOf.get(leadCompany.id) ?? null,
        };
      }
      // The company shown: the lead company the row is listed for, else
      // the newest readable one.
      const company =
        r.conversation.lead.kind === "company"
          ? leadCompany
          : companies.find((c) => c.personId === r.id);
      if (company) {
        r.conversation.person.company = {
          id: company.id,
          name: company.name ?? null,
        };
      }
    }
  }

  return {
    status: "ok",
    conversations: page.map((r) => r.conversation),
    nextCursor,
  };
}
