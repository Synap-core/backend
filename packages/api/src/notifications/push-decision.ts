/**
 * Does this notification EARN a phone push? — the pod half of
 * `@synap-core/types/push`.
 *
 * `NotificationService.create()` resolves the transport (mute, quiet hours,
 * per-type routing rules) exactly as before; when that leaves the `os` channel
 * in, this decides whether the push is actually sent:
 *
 *   1. classify (`classifyPush`) — a type the contract does not name, or a
 *      proposal that blocks nothing, is in-app only;
 *   2. the person's category toggle (`push_prefs` on their POD-WIDE
 *      preferences row — push is about the person's phone, not a workspace, so
 *      a workspace override row never shadows it);
 *   3. an explicit PER-TYPE routing rule of `"os"` / `"all"` wins over both:
 *      the person named that type and asked for its push. A CATEGORY-level
 *      rule does not — it predates the push categories and was never a
 *      statement about one type.
 */
import {
  db,
  desc,
  eq,
  focusSessions,
  proposals,
  storedSessionSource,
} from "@synap/database";
import { loadAgentPresence } from "../services/agent-presence.js";
import { OPEN_SESSION_STATUSES } from "@synap-core/types/focus-sessions";
import {
  classifyPush,
  isPushCategoryEnabled,
  type PushCategory,
  type PushFacts,
  type PushPrefs,
} from "@synap-core/types/push";

export type PushDecision =
  | { push: true; category: PushCategory | null; reason: "earned" | "forced" }
  | {
      push: false;
      category: PushCategory | null;
      reason: "unclassified" | "category_off";
    };

/** Pure: the three rules above, in order. */
export function decidePush(p: {
  type: string;
  typeRule: string | undefined;
  facts: PushFacts;
  prefs: PushPrefs;
}): PushDecision {
  const category = classifyPush(p.type, p.facts);
  if (p.typeRule === "os" || p.typeRule === "all") {
    return { push: true, category, reason: "forced" };
  }
  if (!category) return { push: false, category: null, reason: "unclassified" };
  if (!isPushCategoryEnabled(p.prefs, category)) {
    return { push: false, category, reason: "category_off" };
  }
  return { push: true, category, reason: "earned" };
}

/**
 * Statuses a proposal can block: the open ones, plus `stale` — the reaper
 * marks a long-idle session stale, but an agent that files a proposal from it
 * is back at work and waiting on the decision. Terminal ones never block.
 */
const BLOCKABLE = new Set<string>([...OPEN_SESSION_STATUSES, "stale"]);

/**
 * How recently the filing agent must have called the pod for its proposal to
 * count as something it is waiting on. Its keys stamp `last_used_at` at most
 * once a minute, so this is comfortably above that throttle.
 */
export const PROPOSAL_BLOCKING_SEEN_WITHIN_MS = 15 * 60_000;

/**
 * A proposal BLOCKS work — THE RULE, and why it is this one.
 *
 * The tight rule would be "the agent is waiting on THIS proposal": a recent
 * `wait_for_answer` poll on its session, or an owed slot / `blockedReason`
 * that references it. NEITHER is recorded today: a wait poll writes nothing
 * (it only reads), and an output ref cannot name a proposal
 * (`OUTPUT_REF_KINDS` has no `proposal`). So the rule is the tightest the
 * data supports, every clause required:
 *
 *   1. filed from a session the agent NAMED (`session_id` set and not the
 *      receipt session the pod mints for a stray write, `sessionSource:
 *      "derived"`) — a pod-wide recommendation has none;
 *   2. that session is open or `stale` (see {@link BLOCKABLE});
 *   3. an AGENT filed it (`agent_user_id`) — a person's own proposal blocks
 *      no agent;
 *   4. the agent is PRESENT: its last call is within
 *      {@link PROPOSAL_BLOCKING_SEEN_WITHIN_MS}. An agent with no hub key at
 *      all (a key-less house agent) cannot be measured, so this clause does
 *      not apply to it — "cannot tell" is not "absent";
 *   5. this session is the agent's CURRENT one: its newest proposal anywhere
 *      is in this session.
 *
 * Clauses 4 and 5 hold by construction at FILING time (the agent just
 * called, from this session). They bite when the notification is raised
 * later than the filing (a reactor hop, a retry) or when the agent has moved
 * on to other work since. Recording a wait poll is what would make this rule
 * tight; until then it is honest about what it can see.
 */
export async function proposalBlocksOpenSession(
  proposalId: string,
  now: Date = new Date()
): Promise<boolean> {
  const [row] = await db
    .select({
      sessionId: proposals.sessionId,
      data: proposals.data,
      agentUserId: proposals.agentUserId,
    })
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .limit(1);
  if (!row?.sessionId) return false;
  if (storedSessionSource(row.data) === "derived") return false;
  if (!row.agentUserId) return false;

  const [session] = await db
    .select({ status: focusSessions.status })
    .from(focusSessions)
    .where(eq(focusSessions.id, row.sessionId))
    .limit(1);
  if (!session || !BLOCKABLE.has(session.status)) return false;

  const presence = (await loadAgentPresence([row.agentUserId], now)).get(
    row.agentUserId
  );
  const measurable =
    !!presence &&
    presence.activeKeys + presence.pendingKeys + presence.revokedKeys > 0;
  if (measurable) {
    const seen = presence!.lastSeenAt ? Date.parse(presence!.lastSeenAt) : NaN;
    if (!(now.getTime() - seen <= PROPOSAL_BLOCKING_SEEN_WITHIN_MS)) {
      return false;
    }
  }

  const [latest] = await db
    .select({ sessionId: proposals.sessionId })
    .from(proposals)
    .where(eq(proposals.agentUserId, row.agentUserId))
    .orderBy(desc(proposals.createdAt))
    .limit(1);
  return latest?.sessionId === row.sessionId;
}

/** The facts `classifyPush` needs for this type, computed only when needed. */
export async function derivePushFacts(input: {
  type: string;
  sourceType: string;
  sourceId?: string;
}): Promise<PushFacts> {
  if (
    input.type === "proposal.created" &&
    input.sourceType === "proposal" &&
    input.sourceId
  ) {
    return {
      proposalBlocksOpenSession: await proposalBlocksOpenSession(
        input.sourceId
      ),
    };
  }
  return {};
}

export { readPushPrefs, readPodPushSettings } from "./push-prefs.js";
