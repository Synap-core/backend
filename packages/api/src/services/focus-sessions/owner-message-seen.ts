/**
 * The "Seen by the agent" mark (`@synap/database` `seen-by-agent.ts`) from an
 * agent's own stamped wait: the owner's messages (and answers) it just READ in
 * this session's room. Owner-floored like the wait (`userId` = the session
 * owner, the operator for an agent key); a session with no room stamps
 * nothing. A peek never calls this (`stampReceipt: false`).
 */

import {
  db,
  focusSessions,
  and,
  eq,
  stampMessagesSeenByAgent,
} from "@synap/database";

export async function stampOwnerMessagesSeen(p: {
  sessionId: string;
  userId: string;
  agentUserId?: string | null;
  messageIds: readonly string[];
  now?: Date;
}): Promise<number> {
  if (p.messageIds.length === 0) return 0;
  const [row] = await db
    .select({ channelId: focusSessions.channelId })
    .from(focusSessions)
    .where(
      and(eq(focusSessions.id, p.sessionId), eq(focusSessions.userId, p.userId))
    )
    .limit(1);
  if (!row?.channelId) return 0;
  return stampMessagesSeenByAgent({
    channelId: row.channelId,
    messageIds: p.messageIds,
    agentUserId: p.agentUserId ?? null,
    ...(p.now ? { now: p.now } : {}),
    // This package's `db`, passed rather than the database package's own
    // default: it is the handle a test replaces (the PGlite suite
    // `owner-message-seen.pglite.test.ts` mocks `@synap/database`'s `db`,
    // which the helper's internal import would not see).
    database: db,
  });
}
