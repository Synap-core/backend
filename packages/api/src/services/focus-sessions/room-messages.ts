/**
 * THE SESSION ROOM, as the continuation packet carries it — the last few
 * messages of the session's room, each already classified by WHO wrote it.
 *
 * ── Why the pod classifies ─────────────────────────────────────────────────
 * Every surface that draws a room has to answer "is this the person?", and the
 * columns do not answer it on their own. Measured on live rooms (2026-10-18):
 *   - `role` alone is wrong: an agent posting through MCP writes `role: user`
 *     with `authorType: ai_agent` (`post-message.ts` stamps `ai_agent` from the
 *     key's agent principal, and `userId` stays the HUMAN OWNER);
 *   - `authorType` alone is wrong: the pod's own recall notices ("Found N
 *     things you captured") are `role: assistant` + `authorType: human`;
 *   - neither tells the owner from another person in a shared room — only
 *     `userId` against the session's owner does.
 * So the rule lives HERE, once ({@link classifyRoomAuthor}), and a reader
 * (the synap-bridge terminal band first) renders `author` instead of carrying
 * its own copy.
 *
 * ── Access ─────────────────────────────────────────────────────────────────
 * Read through `queryChannelMessages` WITH the viewer's `userId`, so the
 * canonical channel-visibility gate decides — the same door `getMessages`
 * uses. A viewer who may read the session but not its room gets the section
 * `unavailable`, never an empty room.
 */

import { db, MessageAuthorType, MessageRole } from "@synap/database";
import { queryChannelMessages } from "../../utils/query-channel-messages.js";

/** Messages per packet — the band shows a handful, not the conversation. */
export const ROOM_TOP_N = 8;
/** Characters of `text` per message; longer text ends in "…" and sets `truncated`. */
export const ROOM_TEXT_CAP = 400;

/**
 * Who wrote a room message:
 *  - `person`   — the session's OWNER typing (`role: user`, `authorType:
 *                 human`, `userId` = the session's user). The only one a
 *                 reader may treat as "you said".
 *  - `agent`    — any `ai_agent` row, whatever its `role`.
 *  - `teammate` — another person in the room: a `human` user who is not the
 *                 owner, or an `external` contact (WhatsApp, Slack).
 *  - `system`   — everything the pod itself wrote: recall notices
 *                 (`assistant` + `human`), `bot` rows, `system` rows.
 */
export type RoomAuthor = "person" | "agent" | "teammate" | "system";

export interface RoomMessageAuthorship {
  role: string;
  authorType: string | null;
  userId: string;
}

/** THE rule. Pure, so every disagreeing input can be pinned in a table. */
export function classifyRoomAuthor(
  m: RoomMessageAuthorship,
  sessionUserId: string
): RoomAuthor {
  if (m.authorType === MessageAuthorType.AI_AGENT) return "agent";
  if (m.role === MessageRole.USER) {
    if (m.authorType === MessageAuthorType.EXTERNAL) return "teammate";
    if (m.authorType === MessageAuthorType.HUMAN) {
      return m.userId === sessionUserId ? "person" : "teammate";
    }
  }
  return "system";
}

export interface PacketRoomMessage {
  id: string;
  /** ISO timestamp. */
  at: string;
  /** The stored `role` (`user` · `assistant` · `system`) — provenance only; read `author`. */
  role: string;
  author: RoomAuthor;
  /** `author === "person"` — the one test a reader needs most, precomputed. */
  isPerson: boolean;
  /** The agent principal that posted it, on an `agent` row when recorded. */
  agentUserId?: string;
  /** At most {@link ROOM_TEXT_CAP} characters. */
  text: string;
  truncated: boolean;
}

export type PacketRoomSection =
  | {
      status: "ok";
      /** The room's channel; `null` = the session has no room (a true state). */
      channelId: string | null;
      /** Newest first, at most {@link ROOM_TOP_N}. */
      items: PacketRoomMessage[];
      /** More messages exist past the last item. */
      hasMore: boolean;
      /**
       * The NEWEST message's id (`null` with no messages). A poller compares it
       * with the last cursor it saw: equal ⇒ nothing new in the room.
       */
      cursor: string | null;
    }
  | { status: "unavailable"; reason: string };

interface RoomRow {
  id: string;
  role: string;
  authorType: string | null;
  userId: string;
  content: string;
  timestamp: Date;
  routedTeammateId: string | null;
}

function cap(text: string): { text: string; truncated: boolean } {
  if (text.length <= ROOM_TEXT_CAP) return { text, truncated: false };
  return { text: `${text.slice(0, ROOM_TEXT_CAP - 1)}…`, truncated: true };
}

/**
 * The room section for one session. Throws on a failed read (the packet turns
 * that into `unavailable`); a room the viewer cannot see throws too — the gate
 * says NOT_FOUND, which is not "no messages".
 */
export async function readSessionRoom(
  database: typeof db,
  input: { channelId: string | null; sessionUserId: string; viewerId: string }
): Promise<PacketRoomSection> {
  if (!input.channelId) {
    return {
      status: "ok",
      channelId: null,
      items: [],
      hasMore: false,
      cursor: null,
    };
  }
  const rows = await queryChannelMessages<RoomRow>(database, {
    channelId: input.channelId,
    userId: input.viewerId,
    order: "desc",
    limit: ROOM_TOP_N + 1,
    columns: {
      id: true,
      role: true,
      authorType: true,
      userId: true,
      content: true,
      timestamp: true,
      routedTeammateId: true,
    },
  });
  const page = rows.slice(0, ROOM_TOP_N);
  return {
    status: "ok",
    channelId: input.channelId,
    items: page.map((r) => {
      const author = classifyRoomAuthor(r, input.sessionUserId);
      return {
        id: r.id,
        at: new Date(r.timestamp).toISOString(),
        role: r.role,
        author,
        isPerson: author === "person",
        ...(author === "agent" && r.routedTeammateId
          ? { agentUserId: r.routedTeammateId }
          : {}),
        ...cap(r.content ?? ""),
      };
    }),
    hasMore: rows.length > ROOM_TOP_N,
    cursor: page[0]?.id ?? null,
  };
}
