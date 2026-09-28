/**
 * Session LIVENESS — `lastAgentActivityAt`, projected onto every session list
 * row (`projectSessionRows`: `list`, `browse`, `landed`).
 *
 * "Is an agent still doing anything in here?" is answered from the two places
 * agent work leaves evidence on a session:
 *
 *   1. the proposals an agent filed INTO it (`proposals.session_id` +
 *      `agent_user_id`, indexed by `idx_proposals_session_id`) — every governed
 *      write, receipts included;
 *   2. the messages an agent posted in its ROOM (`messages.channel_id` =
 *      `focus_sessions.channel_id`, `author_type = 'ai_agent'`) — progress,
 *      questions, results.
 *
 * The later of the two, or `null` when neither exists (never the session's own
 * `updatedAt`, which a human's edit or the reaper also moves).
 *
 * BATCH: two grouped reads for the whole page, never one per row. Proposals go
 * through `userVisibleWhere` — the same predicate `attachSessionParticipants`
 * applies to the same rows. Messages are read only by the rooms of sessions the
 * caller already read through the session floor.
 */

import {
  db,
  and,
  eq,
  inArray,
  isNotNull,
  max,
  messages,
  MessageAuthorType,
  proposals,
} from "@synap/database";
import type { SessionAgentActivity } from "@synap-core/types/landed";
import { userVisibleWhere } from "../../utils/user-visible-where.js";

type LiveSession = { id: string; channelId?: string | null };

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function attachLastAgentActivity<T extends LiveSession>(
  sessions: readonly T[],
  userId: string,
  database: typeof db = db
): Promise<Array<T & { lastAgentActivityAt: Date | null }>> {
  if (sessions.length === 0) return [];
  const ids = sessions.map((s) => s.id);
  const channelIds = [
    ...new Set(
      sessions.map((s) => s.channelId).filter((c): c is string => Boolean(c))
    ),
  ];

  const [byProposal, byMessage] = await Promise.all([
    database
      .select({
        sessionId: proposals.sessionId,
        at: max(proposals.createdAt),
      })
      .from(proposals)
      .where(
        and(
          inArray(proposals.sessionId, ids),
          isNotNull(proposals.agentUserId),
          userVisibleWhere(proposals.workspaceId, userId)
        )
      )
      .groupBy(proposals.sessionId),
    channelIds.length
      ? database
          .select({ channelId: messages.channelId, at: max(messages.timestamp) })
          .from(messages)
          .where(
            and(
              inArray(messages.channelId, channelIds),
              eq(messages.authorType, MessageAuthorType.AI_AGENT)
            )
          )
          .groupBy(messages.channelId)
      : Promise.resolve([]),
  ]);

  const proposalAt = new Map(
    byProposal.map((r) => [r.sessionId, toDate(r.at as Date | string | null)])
  );
  const messageAt = new Map(
    byMessage.map((r) => [r.channelId, toDate(r.at as Date | string | null)])
  );

  return sessions.map((s) => {
    const a = proposalAt.get(s.id) ?? null;
    const b = s.channelId ? (messageAt.get(s.channelId) ?? null) : null;
    const latest = a && b ? (a > b ? a : b) : (a ?? b);
    return { ...s, lastAgentActivityAt: latest };
  });
}

// The wire contract this projection fills.
export type { SessionAgentActivity };
