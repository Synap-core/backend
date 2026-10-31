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
 */

import { createLogger } from "@synap-core/core";
import { db, and, eq, focusSessions } from "@synap/database";

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
