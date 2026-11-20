/**
 * DID THE TURN DO ANYTHING? The pod's own judgment at a run turn's end
 * (founder, 20 Nov 2026), on the write-receipt rule (`write-receipt.ts`):
 * a turn is `applied` when something it did reached the pod, `no_effect`
 * when nothing did. The IS's word that its turn `completed` says only that it
 * did not fail; a turn that wrote nothing completes no run.
 *
 * Something reached the pod, since the turn started, attributed to the run's
 * session:
 *   - a write: a proposal filed in the session (applied at once or pending
 *     the person), or an agent's write on the session's event spine (its
 *     auto-applied bookkeeping receipts, outputs included). Transitions are
 *     the pod's own moves, never the agent's write;
 *   - a room message an agent posted, other than the turn's own reply.
 *
 * The turn started when its triggering message was posted (`turnKey`, when
 * it names one in the room), else at `fallbackSince`.
 *
 * THROWS on a failed read: the caller must not take an unread turn for an
 * empty one.
 */
import {
  chatTurns,
  db,
  drizzleSql,
  events,
  messages,
  proposals,
} from "@synap/database";
import { isUuid } from "@synap-core/types/property-render";
import { rowsOf } from "../../utils/execute-rows.js";

export async function turnHadEffect(p: {
  sessionId: string;
  channelId: string | null;
  turnKey?: string | null;
  fallbackSince: Date;
}): Promise<boolean> {
  const fallback = p.fallbackSince.toISOString();
  const key = p.turnKey && isUuid(p.turnKey) ? p.turnKey : null;
  const since = key
    ? drizzleSql`coalesce((SELECT ${messages.timestamp} FROM ${messages} WHERE ${messages.id} = ${key}::uuid), ${fallback}::timestamptz)`
    : drizzleSql`${fallback}::timestamptz`;
  const ownReply = key
    ? drizzleSql`AND ${messages.id} NOT IN (SELECT ${chatTurns.assistantMessageId} FROM ${chatTurns} WHERE ${chatTurns.userMessageId} = ${key}::uuid)`
    : drizzleSql``;
  const roomMessage = p.channelId
    ? drizzleSql`OR EXISTS (
        SELECT 1 FROM ${messages}
        WHERE ${messages.channelId} = ${p.channelId}::uuid
          AND ${messages.timestamp} >= ${since}
          AND ${messages.authorType} = 'ai_agent'
          ${ownReply}
      )`
    : drizzleSql``;
  const result = await db.execute(drizzleSql`
    SELECT (
      EXISTS (
        SELECT 1 FROM ${proposals}
        WHERE ${proposals.sessionId} = ${p.sessionId}::uuid
          AND ${proposals.createdAt} >= ${since}
      )
      OR EXISTS (
        SELECT 1 FROM ${events}
        WHERE ${events.sessionId} = ${p.sessionId}::uuid
          AND ${events.timestamp} >= ${since}
          AND ${events.isAgent} = true
          AND ${events.type} NOT LIKE '%.transition.completed'
      )
      ${roomMessage}
    ) AS effect
  `);
  return rowsOf<{ effect: boolean }>(result)[0]?.effect === true;
}
