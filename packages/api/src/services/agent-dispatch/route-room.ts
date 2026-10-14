/**
 * WHO ANSWERS IN A ROOM — a group room's message, through THE route
 * (`route.ts`, pool = the room's AI members, accept = pod reach).
 *
 * Restraint is the default: silence is the common, correct outcome.
 *
 *   off                         nobody, ever.
 *   an @mention of a member     that member — if the pod runs it. A mention of
 *                               an EXTERNAL member (reach dispatch/pull) is a
 *                               message to it: no IS turn under its name; it is
 *                               returned in `wake` so the caller can reach it
 *                               the way it is reached (founder decision
 *                               2026-10-14: wake it).
 *   a mention naming nobody     silence — never a fallback responder.
 *   only_mentioned, no mention  silence.
 *   when_confident, no mention  the single house agent in the room answers;
 *                               two or more ⇒ the PERSON picks (`choose`, the
 *                               "who should answer?" chip). Never an AI picker
 *                               (founder decision 2026-10-13).
 */

import {
  readRouteChoice,
  type AgentReach,
} from "@synap-core/types/agents";
import {
  db,
  and,
  asc,
  eq,
  channelMembers,
  messages,
  users,
} from "@synap/database";
import {
  AiReactionMode,
  ChannelMemberKind,
} from "@synap/database/schema";
import { resolveMentionedMember } from "../../utils/agent-handles.js";
import { resolveAgentReachMany } from "./agent-binding.js";
import { route } from "./route.js";
import { triggerAutoRespond } from "../../utils/trigger-auto-respond.js";

export interface RoomCandidate {
  agentUserId: string;
  name: string | null;
  agentType: string | null;
}

export type RoomRouting = {
  /** External members the message named — reach them, never with an IS turn. */
  wake: Array<{ agentUserId: string; reach: AgentReach }>;
} & (
  | { kind: "answer"; teammateId: string; source: "mention" | "direct" }
  | { kind: "silent" }
  | { kind: "choose"; candidates: RoomCandidate[] }
);

export async function routeRoomMessage(p: {
  channelId: string;
  /** The person who sent the message (the floor is the room itself). */
  senderId: string;
  reactionMode: AiReactionMode | null;
  /** Every `@handle` in the message, plus a resolved explicit handle. */
  mentionHandles: readonly string[];
}): Promise<RoomRouting> {
  const reactionMode = p.reactionMode ?? AiReactionMode.WHEN_CONFIDENT;
  if (reactionMode === AiReactionMode.OFF) return { kind: "silent", wake: [] };

  const members = await db
    .select({
      agentUserId: channelMembers.memberId,
      name: users.name,
      agentType: users.agentType,
    })
    .from(channelMembers)
    .innerJoin(users, eq(users.id, channelMembers.memberId))
    .where(
      and(
        eq(channelMembers.channelId, p.channelId),
        eq(channelMembers.memberKind, ChannelMemberKind.AI_AGENT)
      )
    )
    .orderBy(asc(channelMembers.createdAt));
  const roster = members.map((m) => m.agentUserId);
  const reach = await resolveAgentReachMany(roster);
  const house = members.filter((m) => reach.get(m.agentUserId) === "pod");
  const external = members.filter((m) => reach.get(m.agentUserId) !== "pod");

  // Mentions: the first handle naming a HOUSE member answers; every external
  // member named is woken (several may be named in one message).
  const wake: RoomRouting["wake"] = [];
  for (const handle of p.mentionHandles) {
    const hit = resolveMentionedMember([handle], external);
    if (hit && !wake.some((w) => w.agentUserId === hit.agentUserId)) {
      wake.push({ agentUserId: hit.agentUserId, reach: reach.get(hit.agentUserId)! });
    }
  }
  const mentioned =
    resolveMentionedMember(p.mentionHandles, house) ??
    resolveMentionedMember(p.mentionHandles, external);

  if (p.mentionHandles.length > 0) {
    if (!mentioned) return { kind: "silent", wake };
    const r = await route({
      ownerId: p.senderId,
      accept: ["pod"],
      selector: { agentUserId: mentioned.agentUserId },
      roster,
      pool: "roster",
    });
    return r.kind === "routed"
      ? { kind: "answer", teammateId: r.agentUserId, source: "mention", wake }
      : { kind: "silent", wake };
  }

  if (reactionMode !== AiReactionMode.WHEN_CONFIDENT) {
    return { kind: "silent", wake };
  }
  const r = await route({
    ownerId: p.senderId,
    accept: ["pod"],
    roster,
    pool: "roster",
  });
  if (r.kind === "routed") {
    return { kind: "answer", teammateId: r.agentUserId, source: "direct", wake };
  }
  if (r.kind === "choose" && r.candidates.length >= 2) {
    const byId = new Map(members.map((m) => [m.agentUserId, m]));
    return {
      kind: "choose",
      candidates: r.candidates.map((id) => byId.get(id)!),
      wake,
    };
  }
  return { kind: "silent", wake };
}

/**
 * The person tapped a "who should answer?" chip: start THAT agent's turn on
 * the original message — re-routed (the agent may have left the room or lost
 * its pod reach since the chip was posted), never trusted from the chip.
 * Called by `channels.answerRouteChoice`, which has already checked the caller
 * can see the channel. A double tap starts one turn: the auto-respond door
 * keys its job on the trigger message.
 */
export async function answerRoomChoice(p: {
  channelId: string;
  callerId: string;
  choiceMessageId: string;
  agentUserId: string;
}): Promise<
  | { status: "started"; agentUserId: string }
  | { status: "not_found" }
  | { status: "refused"; reason: "not_a_candidate" | "no_longer_eligible" | "not_started" }
> {
  const [choiceRow] = await db
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(
      and(eq(messages.id, p.choiceMessageId), eq(messages.channelId, p.channelId))
    )
    .limit(1);
  const choice = readRouteChoice(choiceRow?.metadata);
  if (!choice) return { status: "not_found" };
  if (!choice.candidates.some((c) => c.agentUserId === p.agentUserId)) {
    return { status: "refused", reason: "not_a_candidate" };
  }
  const [trigger] = await db
    .select({ content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.id, choice.triggerMessageId),
        eq(messages.channelId, p.channelId)
      )
    )
    .limit(1);
  if (!trigger) return { status: "not_found" };

  const roster = await db
    .select({ id: channelMembers.memberId })
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, p.channelId),
        eq(channelMembers.memberKind, ChannelMemberKind.AI_AGENT)
      )
    );
  const r = await route({
    ownerId: p.callerId,
    accept: ["pod"],
    selector: { agentUserId: p.agentUserId },
    roster: roster.map((m) => m.id),
    pool: "roster",
  });
  if (r.kind !== "routed") return { status: "refused", reason: "no_longer_eligible" };

  const [agent] = await db
    .select({ agentType: users.agentType })
    .from(users)
    .where(eq(users.id, r.agentUserId))
    .limit(1);
  const started = await triggerAutoRespond({
    channelId: p.channelId,
    userMessageId: choice.triggerMessageId,
    content: trigger.content,
    sourceUserId: p.callerId,
    agentType: agent?.agentType ?? null,
  });
  return started
    ? { status: "started", agentUserId: r.agentUserId }
    : { status: "refused", reason: "not_started" };
}
