/**
 * WHICH CONVERSATION A NEW SESSION IS BOUND TO (plan d679e92c C7, part 1).
 *
 * `synap_start_session` stamps the calling conversation's `clientKey` on the
 * session it starts (`metadata.clientKey`), so the conversation's later
 * unaddressed writes are filed there (ambient attribution) and the receipt
 * the gate auto-opened is adopted. That is right when the conversation starts
 * work for ITSELF. It is wrong when the session is started for someone else:
 *
 *  - for ANOTHER AGENT (`agentIds` names an agent other than the caller): the
 *    session is that agent's work, not this conversation's;
 *  - for a TEAMMATE: subagents run inside their lead's Claude Code process and
 *    share its conversation key, so a lane's start stamped the LEAD's key on
 *    the lane's session and the lead's next writes were filed on the lane
 *    (finding 06f4bc12 and 7 others; three misattributions in one night). The
 *    pod recognises it by its shape: a planned sub-session (`parentSessionId`,
 *    no `suspendedIntent`) of a session ALREADY bound to this very
 *    conversation. The conversation stays with its parent; the lane writes
 *    with its own `sessionId`, as `rules/work-units` requires.
 *
 * A DETOUR (`suspendedIntent`) keeps the stamp: the conversation itself steps
 * into it and pops back. A start with no parent keeps it too.
 *
 * ATTACH ON NAMING (founder's answer 6, 21 Nov 2026; finding 3edcbe5c): a
 * conversation that has NO session of its own and names an existing session
 * as its own (`sessionId` on a write, `fromSessionId` on a coordination post)
 * is attached to it ({@link attachConversationToNamedSession}). A lead that
 * moves to a new conversation (a restart, `/clear`, `/branch`) thereby takes
 * its wave session back the first time it names it, instead of being bound to
 * the first lane it starts.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  inArray,
  drizzleSql,
  focusSessions,
  conversationCwdPatch,
} from "@synap/database";
import { IN_FLIGHT_SESSION_STATUSES } from "./session-statuses.js";
import { parseRunnerClientKey } from "./session-runners.js";

const logger = createLogger({ module: "session-client-binding" });

export interface ClientBindingFacts {
  /** The calling conversation's key (`requestClientKey`). */
  clientKey: string | null | undefined;
  agentUserId: string | null | undefined;
  agentIds?: readonly string[] | null;
  parentSessionId?: string | null;
  suspendedIntent?: string | null;
  /** The parent's `metadata.clientKey`; `undefined` when not read. */
  parentClientKey?: string | null;
}

/** Started for an agent other than the caller? */
export function startedForAnotherAgent(
  agentIds: readonly string[] | null | undefined,
  agentUserId: string | null | undefined
): boolean {
  return (agentIds ?? []).some((id) => id !== agentUserId);
}

/** A planned sub-session (not a detour) of a parent. */
function isPlannedChild(f: ClientBindingFacts): boolean {
  return !!f.parentSessionId && !f.suspendedIntent?.trim();
}

/** The key to stamp on the new session, or null (pure: the rule above). */
export function decideNewSessionClientKey(
  f: ClientBindingFacts
): string | null {
  if (!f.clientKey) return null;
  if (startedForAnotherAgent(f.agentIds, f.agentUserId)) return null;
  if (isPlannedChild(f) && f.parentClientKey === f.clientKey) return null;
  return f.clientKey;
}

/**
 * The key to stamp, reading the parent's binding when the rule needs it. A
 * failed parent read stamps NOTHING: a missing stamp costs only ambient
 * filing (the agent passes its `sessionId`), a wrong one re-binds a lead.
 */
export async function newSessionClientKey(
  f: Omit<ClientBindingFacts, "parentClientKey"> & { userId: string }
): Promise<string | null> {
  if (!f.clientKey) return null;
  if (startedForAnotherAgent(f.agentIds, f.agentUserId)) return null;
  if (!isPlannedChild(f)) return f.clientKey;
  try {
    const [parent] = await db
      .select({ metadata: focusSessions.metadata })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.id, f.parentSessionId!),
          eq(focusSessions.userId, f.userId)
        )
      )
      .limit(1);
    const parentClientKey =
      (parent?.metadata as { clientKey?: unknown } | null)?.clientKey ?? null;
    return decideNewSessionClientKey({
      ...f,
      parentClientKey:
        typeof parentClientKey === "string" ? parentClientKey : null,
    });
  } catch (err) {
    logger.warn(
      { err, parentSessionId: f.parentSessionId },
      "parent binding read failed; the new session is not bound to the conversation"
    );
    return null;
  }
}

/**
 * Attach THIS conversation to the session it named, when it has none of its
 * own. One conditional UPDATE, so the rule and the write cannot drift apart.
 * The session's `metadata.clientKey` becomes this conversation's key when ALL
 * hold; otherwise nothing changes and the call is attributed to the named
 * session for this call only, as before:
 *
 *  - the client NAMED its conversation (`key:<apiKeyId>|conv:<harness>:<id>`).
 *    A key-scoped client, a per-call run, an IS channel or a pod-minted MCP
 *    session id never attaches: none of them is one conversation a later
 *    request can be told apart by (option A, D1);
 *  - the conversation has no open session it STARTED (an auto-opened receipt
 *    does not count: it groups writes, it is not work the conversation chose).
 *    A conversation that has its own session and names another (a lead naming
 *    a lane, a teammate naming its lane under its lead's conversation) keeps
 *    its own: the named session is used for that call only;
 *  - the named session is the caller's, open, started (not a receipt), and
 *    bound to the SAME API key (one of its earlier conversations or runs).
 *    A session bound to another key is another client's work, and a session
 *    bound to no client is the person's: neither is ever taken over.
 *
 * Returns whether it attached. Never throws: a failed attach costs only
 * ambient filing, never the call.
 */
export async function attachConversationToNamedSession(p: {
  userId: string;
  clientKey: string | null | undefined;
  sessionId: string;
}): Promise<boolean> {
  const conversation = parseRunnerClientKey(p.clientKey);
  if (!conversation || !p.clientKey) return false;
  const clientKey = p.clientKey;
  const sameKey = `key:${conversation.apiKeyId}`;
  const boundKey = drizzleSql`lower(${focusSessions.metadata} ->> 'clientKey')`;
  const started = drizzleSql`NOT coalesce((${focusSessions.metadata} ->> 'autoOpened')::boolean, false)`;
  try {
    const rows = await db
      .update(focusSessions)
      .set({
        metadata: drizzleSql`coalesce(${focusSessions.metadata}, '{}'::jsonb) || ${JSON.stringify(
          { clientKey, ...conversationCwdPatch(clientKey) }
        )}::jsonb`,
      })
      .where(
        and(
          eq(focusSessions.id, p.sessionId),
          eq(focusSessions.userId, p.userId),
          inArray(focusSessions.status, [...IN_FLIGHT_SESSION_STATUSES]),
          started,
          drizzleSql`${focusSessions.metadata} ->> 'clientKey' IS DISTINCT FROM ${clientKey}`,
          drizzleSql`(${boundKey} = ${sameKey} OR left(${boundKey}, ${sameKey.length + 1}) = ${`${sameKey}|`})`,
          drizzleSql`NOT EXISTS (
            SELECT 1 FROM focus_sessions own
            WHERE own.user_id = ${p.userId}
              AND own.status IN (${drizzleSql.join(
                IN_FLIGHT_SESSION_STATUSES.map((s) => drizzleSql`${s}`),
                drizzleSql`, `
              )})
              AND own.metadata ->> 'clientKey' = ${clientKey}
              AND NOT coalesce((own.metadata ->> 'autoOpened')::boolean, false)
          )`
        )
      )
      .returning({ id: focusSessions.id });
    if (rows.length === 0) return false;
    logger.info(
      { sessionId: p.sessionId, clientKey },
      "conversation attached to the session it named"
    );
    return true;
  } catch (err) {
    logger.warn(
      { err, sessionId: p.sessionId },
      "attach on naming failed; the named session is used for this call only"
    );
    return false;
  }
}
