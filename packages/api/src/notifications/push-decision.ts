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
 *      statement about one type;
 *   4. the interruption budget ({@link withinPushCap}): an EARNED push past
 *      the person's {@link PUSH_DAILY_CAP} pushes today is held back — the row
 *      stays in the bell and in needs-you. "Something broke" (`work-broke`)
 *      and what the person sent to their phone (`sent-by-you`) are exempt
 *      and never counted (`PUSH_CAP_EXEMPT_CATEGORIES`); a forced push (rule 3) is the person's own
 *      ask and is never held back, but it counts. The count is read only when
 *      the cap applies (`pushCapApplies`), so no exempt or forced push waits
 *      on it.
 *   5. the person's SESSION MUTE ({@link withSessionMute}): a push about a
 *      session they muted is held back, whatever its category (an ask too),
 *      except what they sent to their phone themselves
 *      (`PUSH_MUTE_EXEMPT_CATEGORIES`). Held back, never hidden: the row is
 *      already in the bell and an owed ask stays in needs-you. Decided before
 *      the budget, so a muted push is never counted.
 */
import {
  and,
  db,
  desc,
  drizzleSql,
  eq,
  focusSessions,
  isNotNull,
  notifications,
  proposals,
  storedSessionSource,
} from "@synap/database";
import { UUID_RE } from "../services/focus-sessions/session-metadata.js";
import { loadAgentPresence } from "../services/agent-presence.js";
import { OPEN_SESSION_STATUSES } from "@synap-core/types/focus-sessions";
import {
  PUSH_CAP_EXEMPT_CATEGORIES,
  PUSH_DAILY_CAP,
  PUSH_MUTE_EXEMPT_CATEGORIES,
  classifyPush,
  isPushCategoryEnabled,
  isSessionPushMuted,
  pushCapExemptTypes,
  type PushCategory,
  type PushFacts,
  type PushPrefs,
} from "@synap-core/types/push";

export type PushDecision =
  | { push: true; category: PushCategory | null; reason: "earned" | "forced" }
  | {
      push: false;
      category: PushCategory | null;
      reason: "unclassified" | "category_off" | "over_cap" | "session_muted";
    };

/** Pure: rules 1-3 above, in order. */
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

/** Rule 4 applies only to an EARNED push in a counted category. Pure. */
export function pushCapApplies(d: PushDecision): boolean {
  return (
    d.push &&
    d.reason === "earned" &&
    d.category !== null &&
    !PUSH_CAP_EXEMPT_CATEGORIES.includes(d.category)
  );
}

/**
 * Rule 4, pure: hold back an earned push once the person had their pushes
 * today. Accepted overshoot: the count is read, then the push recorded, so
 * two pushes deciding at the same instant can both pass at the cap's edge.
 */
export function withinPushCap(
  d: PushDecision,
  pushedToday: number
): PushDecision {
  return pushCapApplies(d) && pushedToday >= PUSH_DAILY_CAP
    ? { push: false, category: d.category, reason: "over_cap" }
    : d;
}

/**
 * Rule 5, pure: hold back a push about a session the person muted. `muted` is
 * the answer of {@link pushAboutMutedSession}. A push in a mute-exempt
 * category (what the person sent to their own phone) still goes out.
 */
export function withSessionMute(d: PushDecision, muted: boolean): PushDecision {
  if (!d.push || !muted) return d;
  if (d.category && PUSH_MUTE_EXEMPT_CATEGORIES.includes(d.category)) return d;
  return { push: false, category: d.category, reason: "session_muted" };
}

/** What a notification says about where it comes from — the session lookup's input. */
export interface NotificationSessionSource {
  sourceType: string;
  sourceId?: string;
  target?: { kind: string; id: string } | null;
  data?: Record<string, unknown>;
  push?: { threadId?: string };
}

const isUuid = (v: unknown): v is string =>
  typeof v === "string" && UUID_RE.test(v);

/**
 * The sessions a notification is ABOUT, from what it carries, no read: a
 * session source (`sourceType: "session"`), a tap target on a session or its
 * owed page, a `sessionId` in its data, and the iOS thread a session's pushes
 * stack under (`threadId` = the session id, `notify-needs-you.ts`). Pure.
 */
export function notificationSessionIds(n: NotificationSessionSource): string[] {
  const out = new Set<string>();
  if (n.sourceType === "session" && isUuid(n.sourceId)) out.add(n.sourceId);
  if (
    n.target &&
    (n.target.kind === "session" || n.target.kind === "owed") &&
    isUuid(n.target.id)
  ) {
    out.add(n.target.id);
  }
  const dataSessionId = n.data?.sessionId;
  if (isUuid(dataSessionId)) out.add(dataSessionId);
  const threadId = n.push?.threadId;
  if (isUuid(threadId)) out.add(threadId);
  return [...new Set([...out].map((id) => id.toLowerCase()))];
}

/**
 * Rule 5's question: is this notification about a session in `mutedSessions`?
 * Free when nothing is muted (no read). Otherwise it also follows the two
 * links a notification carries without naming the session: a proposal's
 * session (`proposals.session_id`) and a room's session (the session whose
 * room is `data.channelId`, e.g. an @mention there). A FAILED read throws
 * (the caller skips the push decision's mute, logged — see NotificationService).
 */
export async function pushAboutMutedSession(
  n: NotificationSessionSource,
  mutedSessions: readonly string[] | undefined
): Promise<boolean> {
  if (!mutedSessions || mutedSessions.length === 0) return false;
  const prefs = { mutedSessions: [...mutedSessions] };
  const direct = notificationSessionIds(n);
  if (direct.some((id) => isSessionPushMuted(prefs, id))) return true;
  if (n.sourceType === "proposal" && isUuid(n.sourceId)) {
    const [row] = await db
      .select({ sessionId: proposals.sessionId })
      .from(proposals)
      .where(eq(proposals.id, n.sourceId))
      .limit(1);
    if (isSessionPushMuted(prefs, row?.sessionId)) return true;
  }
  const channelId = n.data?.channelId;
  if (isUuid(channelId)) {
    const [row] = await db
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(eq(focusSessions.channelId, channelId))
      .limit(1);
    if (isSessionPushMuted(prefs, row?.id)) return true;
  }
  return false;
}

/**
 * The pushes the cap counts that `userId` got since the start of THEIR day
 * (`timeZone`, a VALID IANA name: `recipientTimezone` checks it): every row
 * pushed today (`pushed_at`) except "something broke" types. A failed read
 * THROWS (the caller logs it, and skips the push unless it is a blocking ask).
 */
export async function pushesCountedToday(
  userId: string,
  timeZone: string
): Promise<number> {
  const exempt = pushCapExemptTypes();
  const [row] = await db
    .select({ n: drizzleSql<number>`cast(count(*) as integer)` })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        isNotNull(notifications.pushedAt),
        drizzleSql`${notifications.pushedAt} >= (date_trunc('day', now() AT TIME ZONE ${timeZone}) AT TIME ZONE ${timeZone})`,
        exempt.length
          ? drizzleSql`${notifications.type} NOT IN (${drizzleSql.join(
              exempt.map((t) => drizzleSql`${t}`),
              drizzleSql`, `
            )})`
          : undefined
      )
    );
  return Number(row?.n ?? 0);
}

/** Record that a row's push went out — what {@link pushesCountedToday} counts. */
export async function recordPush(notificationId: string): Promise<void> {
  // No Date bind (postgres.js 3.4.8 crashes on it on the pod image).
  await db
    .update(notifications)
    .set({ pushedAt: drizzleSql`now()` })
    .where(eq(notifications.id, notificationId));
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
