/**
 * WHO an agent turn in a room runs as — the ONE rule, shared by the headless
 * door (`triggerAutoRespond`) and the interactive door (`chat.sendMessage`).
 *
 * FOUNDER DECISION D (2026-09-25): in a shared room, "@ai" acts AS WHOEVER
 * SUMMONED IT — their data access, their governance. Slack AI's rule ("AI
 * responses only include information available to you"), not the room
 * owner's.
 *
 * WHY IT MATTERS. The IS turn's identity is exactly the `userId` it is handed:
 * the IS sends it as `X-Delegated-Operator-Id`, and the pod's hub auth
 * (`_middleware/auth.ts`, is_internal branch) makes it the request's `userId` —
 * the read floor of every `ask` / `find` / `get_entity`, and the operator the
 * governance ladder (`checkPermissionOrPropose`) decides on. The headless door
 * used to pass the ROOM OWNER unconditionally, so a second human's "@ai …" in
 * a session room ran on the owner's pod-wide read scope and posted the answer
 * where the member reads it: a confused deputy, live the moment a room can
 * hold a second human (`chat.addRoomMember`).
 *
 * THE RULE.
 *   - no summoner, or the summoner IS the room owner → the owner (unchanged:
 *     slot answers, delegated outputs and every owner flow stay the owner's);
 *   - a HUMAN summoner → that human;
 *   - an AGENT summoner → the human that agent belongs to
 *     (`users.createdByUserId`, the same ownership column
 *     `ensurePersonalAgentUser` writes). An agent with no owning human (a
 *     system agent) keeps today's behaviour — the owner — because there is no
 *     non-owner person whose access it could be borrowing;
 *   - an id that resolves to no user → the owner, same reasoning.
 *
 * Running as the summoner is never a widening: it is the least-privileged
 * identity the turn could take, and the summoner already chose to post in the
 * room the answer lands in. Deciding whether the summoner MAY post there is the
 * caller's job (every door authorizes the channel before it gets here).
 */

import { db, eq, users } from "@synap/database";
import { ensurePersonalAgentUser } from "../../utils/personal-agent-user.js";

export interface TurnPrincipal {
  /** The user the turn runs as — floor, governance, IS routing. */
  userId: string;
  /** Whether that is the room owner (an unchanged turn) or someone else. */
  isRoomOwner: boolean;
}

export async function resolveTurnPrincipal(p: {
  roomOwnerId: string;
  summonerId?: string | null;
}): Promise<TurnPrincipal> {
  const owner: TurnPrincipal = { userId: p.roomOwnerId, isRoomOwner: true };
  const summonerId = p.summonerId?.trim();
  if (!summonerId || summonerId === p.roomOwnerId) return owner;

  const row = await db.query.users.findFirst({
    where: eq(users.id, summonerId),
    columns: { id: true, userType: true, createdByUserId: true },
  });
  if (!row) return owner;

  const human =
    row.userType === "agent" ? (row.createdByUserId ?? null) : row.id;
  if (!human || human === p.roomOwnerId) return owner;
  return { userId: human, isRoomOwner: false };
}

/**
 * WHICH AGENT an interactive Synap AI turn acts as: the turn principal's ONE
 * personal AI (decision 6b45c6c3, founder 2026-11-09: "My one personal AI";
 * "Modes of my one AI").
 *
 * The routing engine still picks a roster teammate, and the teammate still
 * decides the persona (`agentType`) and the presence the room shows. But a
 * pod persona (Planner, Executor, Meta Orchestrator, the owner's own
 * orchestrator...) is a MODE of the person's AI, never an identity of its own:
 * the turn writes as the principal's personal agent, under its governance and
 * the principal's Synap AI ceiling. A member summoning the owner's @ai acts as
 * the MEMBER's AI (founder decision D: the summoner, never the owner on their
 * behalf). An external worker (Claude Code, Hermes...) is never an IS turn: it
 * is reached its own way and writes as itself with its own key.
 *
 * Nothing enrolls the AI in the room's space: a write where it is not a member
 * goes to the governance gate (a `workspace.join` proposal or a refusal).
 */
export async function resolveTurnAgentUserId(p: {
  /** The turn principal (`resolveTurnPrincipal`, or the sender). */
  principalUserId: string;
}): Promise<string> {
  return ensurePersonalAgentUser(p.principalUserId);
}
