/**
 * attachSessionAgent — the ONE append-only door onto `focus_sessions.agentIds`.
 *
 * WHY IT HAS TO EXIST. Every writer of that column REPLACES it wholesale at
 * create time — `create-session.ts`, `open-run-session.ts`, the playbook
 * lifecycle and run paths, and the `focus_session/create` executor all seed it
 * from a caller-supplied array — and the two update doors (tRPC
 * `focusSessions.update`, Hub `PATCH /focus-sessions/:id`) also assign it
 * wholesale. NOTHING appends. So the column is an INVITE LIST, not a roster: an
 * agent that joins a session already in flight can never be recorded in it, and
 * an agent nobody named up front leaves the list empty however much work it does.
 *
 * That is why `focusSessions.get` derives its `participants` from the proposals
 * filed against the session instead. The derivation stays authoritative — it is
 * evidence of work, and this column is a declaration of intent — but a
 * declaration with no append door is a declaration nobody can ever make after
 * the first instant, which is the severance this door closes.
 *
 * SHAPE — deliberately `FacetRepository.attach`'s:
 *   - IDEMPOTENT. Attaching an agent already on the list is a success that
 *     wrote nothing (`added: false`), never an error and never a duplicate.
 *   - ARRAY-UNIQUE. The read-modify-write happens inside a row-locked
 *     transaction, so two concurrent attaches cannot both read the pre-state
 *     and clobber each other (the TOCTOU `update-session.ts` already guards its
 *     own JSONB RMW against).
 *   - OWNER-FLOORED. `focus_sessions` is owner-private and carries no
 *     `VisibilityRule`, so the floor is an explicit `userId` predicate on the
 *     load — the SAME instrument `session-blocked-by.ts`, `session-outputs.ts`
 *     and `update-session.ts` use, and the reason none of them reach for
 *     `assertWorkspaceWrite` (there is no workspace-shaped access question to
 *     ask about a row only its owner can see). A session that is missing and a
 *     session that is not yours are indistinguishable on purpose.
 *
 * ROOM ROSTER. When the session has a room, the agent is also enrolled on its
 * roster (`enrollRoomMember`, idempotent) inside the SAME locked transaction:
 * session rooms are GROUP rooms where an agent answers only when @-mentioned,
 * and a mention routes only to a roster member — staffing a session with an
 * agent the room cannot summon would be the same severance one level down.
 * Enrolled even when the agent was already on the list (`added: false`), so a
 * room minted before its roster existed heals on the next attach.
 *
 * NOT A GOVERNANCE GATE. This door writes; deciding whether an agent MAY write
 * is the caller's job, exactly as it is for `recordSessionSpawn` and the
 * blocked-by producer. The MCP and Hub REST doors run `checkPermissionOrPropose`
 * before calling in; the tRPC door is a human operator acting on their own
 * session.
 */

import { db, focusSessions, and, eq, ChannelMemberKind } from "@synap/database";
import { enrollRoomMember } from "../messaging/enroll-room-member.js";

export interface AttachSessionAgentParams {
  /** The session to staff. */
  sessionId: string;
  /** The agent user id to append. */
  agentId: string;
  /** Owner floor — the session must belong to this user. */
  userId: string;
}

export type AttachSessionAgentResult =
  | { status: "not_found" }
  | {
      status: "attached";
      /** The full list AFTER the attach — the caller never re-reads. */
      agentIds: string[];
      /** `false` ⇒ already present, nothing was written. */
      added: boolean;
    };

export async function attachSessionAgent(
  params: AttachSessionAgentParams
): Promise<AttachSessionAgentResult> {
  const { sessionId, agentId, userId } = params;

  const trimmed = agentId.trim();
  if (trimmed === "") return { status: "not_found" };

  return await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        agentIds: focusSessions.agentIds,
        channelId: focusSessions.channelId,
      })
      .from(focusSessions)
      .where(
        and(eq(focusSessions.id, sessionId), eq(focusSessions.userId, userId))
      )
      .for("update");
    if (!locked) return { status: "not_found" };

    if (locked.channelId) {
      await enrollRoomMember(tx, {
        channelId: locked.channelId,
        userId: trimmed,
        memberType: ChannelMemberKind.AI_AGENT,
        addedBy: userId,
      });
    }

    const current = Array.isArray(locked.agentIds) ? locked.agentIds : [];
    if (current.includes(trimmed)) {
      return { status: "attached", agentIds: current, added: false };
    }

    const next = [...current, trimmed];
    await tx
      .update(focusSessions)
      .set({ agentIds: next, updatedAt: new Date() })
      .where(eq(focusSessions.id, sessionId));

    return { status: "attached", agentIds: next, added: true };
  });
}
