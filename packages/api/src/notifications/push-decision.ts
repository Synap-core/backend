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
  eq,
  focusSessions,
  proposals,
  storedSessionSource,
} from "@synap/database";
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

const OPEN = new Set<string>(OPEN_SESSION_STATUSES);

/**
 * A proposal BLOCKS work when it was filed from an open session or run the
 * agent was explicitly working in. The receipt session the pod mints for a
 * stray agent write (`sessionSource: "derived"`) groups the proposal; nothing
 * waits on it. A pod-wide governance recommendation has no session at all.
 */
export async function proposalBlocksOpenSession(
  proposalId: string
): Promise<boolean> {
  const [row] = await db
    .select({ sessionId: proposals.sessionId, data: proposals.data })
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .limit(1);
  if (!row?.sessionId) return false;
  if (storedSessionSource(row.data) === "derived") return false;
  const [session] = await db
    .select({ status: focusSessions.status })
    .from(focusSessions)
    .where(eq(focusSessions.id, row.sessionId))
    .limit(1);
  return !!session && OPEN.has(session.status);
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

export { readPushPrefs } from "./push-prefs.js";
