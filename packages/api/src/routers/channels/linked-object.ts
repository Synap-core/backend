/**
 * resolveChannelLinkedObject — WHAT a conversation belongs to, so its page can
 * be a door to it (ui-composition §3: everything named is a door).
 *
 * First match wins:
 *   1. the channel's own context stamp (`context_object_type/id`): a session
 *      room minted by `ensureSessionChannel` carries `focus_session`, a client
 *      thread its entity, a proposal thread its proposal;
 *   2. a session that uses this channel as its room (`focus_sessions.channel_id`)
 *      and that the reader may read: a session can BORROW an existing chat,
 *      which carries no stamp;
 *   3. the conversation it branched from (`parent_channel_id`), when the reader
 *      may see it.
 *
 * Only the stamp (already on the channel row the caller can read) is returned
 * whatever the reader may see; the session and the parent are found through
 * their own read predicates, so a borrowed room never reveals a session or a
 * parent its reader cannot open. Titles come only through access-scoped reads
 * (`sessionReadableWhere`; `scopedDb`, whose channels rule is
 * `channelVisibilityWhere`). A stamped object the reader cannot read keeps its
 * link (its page bounces honestly) and a null title.
 */

import { and, db, desc, eq, inArray } from "@synap/database";
import {
  channels,
  documents as documentsTable,
  entities as entitiesTable,
  focusSessions,
} from "@synap/database/schema";
import { type AccessContext, scopedDb } from "../../access/index.js";
import { sessionReadableWhere } from "../../access/session-visibility.js";

/** The object a conversation belongs to: an `/open/<type>/<id>` address. */
export interface ChannelLinkedObject {
  /** The open grammar's kind (`session`, `entity`, `document`, `channel`, …). */
  type: string;
  id: string;
  /** Its name, when the reader may read it; null otherwise. */
  title: string | null;
  /** Which rule found it. */
  via: "context" | "session_room" | "parent";
}

/** The channel stamp's types that the open grammar names differently. */
const OPEN_TYPE_OF_CONTEXT: Readonly<Record<string, string>> = {
  focus_session: "session",
};

export function openTypeOfContext(contextObjectType: string): string {
  return OPEN_TYPE_OF_CONTEXT[contextObjectType] ?? contextObjectType;
}

export interface LinkedObjectReader {
  userId: string;
  access: AccessContext;
  /** Honour the session roster branch: `rosterReadFor(ctx)` (a human door). */
  roster: boolean;
}

type ChannelLinkFields = {
  id: string;
  contextObjectType: string | null;
  contextObjectId: string | null;
  parentChannelId: string | null;
};

async function readableSession(
  reader: LinkedObjectReader,
  where: ReturnType<typeof eq>
): Promise<{ id: string; title: string | null } | null> {
  // SESSION-KIND-LENS-EXEMPT: resolves ONE session (id + title) a conversation belongs to — no session row is returned to a consumer.
  const [row] = await db
    .select({ id: focusSessions.id, title: focusSessions.title })
    .from(focusSessions)
    .where(
      and(
        where,
        sessionReadableWhere({
          userId: reader.userId,
          roster: reader.roster,
        })
      )
    )
    .orderBy(desc(focusSessions.updatedAt))
    .limit(1);
  return row ?? null;
}

async function titleOf(
  type: string,
  id: string,
  reader: LinkedObjectReader
): Promise<string | null> {
  if (type === "session") {
    return (
      (await readableSession(reader, eq(focusSessions.id, id)))?.title ?? null
    );
  }
  if (type === "entity" || type === "document") {
    const table = type === "entity" ? entitiesTable : documentsTable;
    const rows = await scopedDb(reader.access).findMany<{
      id: string;
      title: string | null;
    }>(table, {
      where: inArray(table.id, [id]),
      columns: { id: true, title: true },
    });
    return rows[0]?.title ?? null;
  }
  if (type === "channel") {
    return (await visibleChannel(id, reader))?.title ?? null;
  }
  return null;
}

/** A channel by id, through the channels visibility rule (`channelVisibilityWhere`). */
async function visibleChannel(
  id: string,
  reader: LinkedObjectReader
): Promise<{ id: string; title: string | null } | null> {
  const rows = await scopedDb(reader.access).findMany<{
    id: string;
    title: string | null;
  }>(channels, {
    where: eq(channels.id, id),
    columns: { id: true, title: true },
  });
  return rows[0] ?? null;
}

export async function resolveChannelLinkedObject(
  channel: ChannelLinkFields,
  reader: LinkedObjectReader
): Promise<ChannelLinkedObject | null> {
  if (channel.contextObjectType && channel.contextObjectId) {
    const type = openTypeOfContext(channel.contextObjectType);
    return {
      type,
      id: channel.contextObjectId,
      title: await titleOf(type, channel.contextObjectId, reader),
      via: "context",
    };
  }

  const session = await readableSession(
    reader,
    eq(focusSessions.channelId, channel.id)
  );
  if (session) {
    return {
      type: "session",
      id: session.id,
      title: session.title,
      via: "session_room",
    };
  }

  if (channel.parentChannelId) {
    const parent = await visibleChannel(channel.parentChannelId, reader);
    if (parent) {
      return {
        type: "channel",
        id: parent.id,
        title: parent.title,
        via: "parent",
      };
    }
  }

  return null;
}
