/**
 * orient's `startHere`, in action order: pending review, open work sessions,
 * most-used kinds, runnable actions, one skill pointer. Each section reads an
 * existing door; one that cannot be read is `{ status: "unavailable" }`, never
 * an empty list or a zero.
 */

import type { HubProtocolCaller } from "../../routers/hub-protocol/rest/_shared.js";
import { openLink } from "../../utils/deep-links.js";
import {
  rankProfilesByUsage,
  profileDisplayName,
  USED_MOST_LIMIT,
  type RankableProfile,
} from "./profile-ranking.js";
import type { StartHere } from "./discover.js";

/** Open sessions read before reporting "at least N". */
export const OPEN_SESSIONS_READ_CAP = 10;

export type PendingReviewState =
  | { status: "ok"; count: number; oldestDays: number; oldestId?: string }
  | { status: "unavailable" };

const UNAVAILABLE = { status: "unavailable" } as const;

async function readOpenSessions(
  userId: string
): Promise<StartHere["openSessions"]> {
  try {
    const { listOpenFocusSessions } =
      await import("../../routers/mcp/handlers/shared.js");
    // `throw`, not the default swallow: this section REPORTS a count, and a
    // failed read is not "0 sessions open".
    const open = await listOpenFocusSessions(userId, OPEN_SESSIONS_READ_CAP, {
      onError: "throw",
    });
    const newest = open[0];
    return {
      count: open.length,
      countIsLowerBound: open.length >= OPEN_SESSIONS_READ_CAP,
      ...(newest
        ? {
            newest: {
              id: newest.id,
              goal: newest.goal,
              startedAt: newest.startedAt
                ? new Date(newest.startedAt).toISOString()
                : null,
            },
          }
        : {}),
    };
  } catch {
    return UNAVAILABLE;
  }
}

async function readTopKinds(p: {
  caller: HubProtocolCaller;
  userId: string;
  workspaceId?: string;
}): Promise<StartHere["topKinds"]> {
  try {
    const res = await p.caller.profiles.listProfiles({
      userId: p.userId,
      ...(p.workspaceId ? { workspaceId: p.workspaceId } : {}),
    });
    const profiles = ((res as { profiles?: unknown }).profiles ?? []) as Array<
      RankableProfile & { profileKind?: string }
    >;
    // Rank the WHOLE listing, then keep kinds — so a kind's `rank` is the same
    // number `GET /discover?summary=true` gives it at the same lens.
    const { ranked } = await rankProfilesByUsage({
      userId: p.userId,
      workspaceId: p.workspaceId,
      profiles: profiles.filter((row) => Boolean(row.slug)),
    });
    return ranked
      .filter(
        (r) => r.score > 0 && (r.profile.profileKind ?? "kind") === "kind"
      )
      .slice(0, USED_MOST_LIMIT)
      .map((r) => ({
        slug: r.profile.slug,
        name: profileDisplayName(r.profile),
        entityCount: r.entityCount,
        lastActivityAt: r.lastActivityAt,
        rank: r.rank,
      }));
  } catch {
    return UNAVAILABLE;
  }
}

async function readActions(p: {
  userId: string;
  workspaceId?: string;
}): Promise<StartHere["actions"]> {
  try {
    const [{ listCapabilities }, { projectRunnableActions }] =
      await Promise.all([
        import("../capabilities/capability-registry.js"),
        import("../capabilities/action-projection.js"),
      ]);
    // `workspaceId` reaching here was already checked against the caller's
    // accessible workspaces by `discover()` (the registry treats it as a LENS,
    // not an authorization). Unpinned = pod altitude, and the result says so.
    const actions = projectRunnableActions(
      await listCapabilities({
        workspaceId: p.workspaceId ?? null,
        userId: p.userId,
      })
    );
    return {
      count: actions.length,
      examples: actions.slice(0, 3).map((a) => a.label),
      lens: p.workspaceId ?? "pod",
    };
  } catch {
    return UNAVAILABLE;
  }
}

/**
 * Open blocker-class findings — defects in SYNAP ITSELF that an agent is about
 * to walk into.
 *
 * WHY THIS IS A FIELD ON `orient` AND NOT A PLAYBOOK. A playbook only runs if
 * the agent knows the playbook exists, and it will not. `orient` is the one
 * door every agent already calls at the start of every session, so a known
 * blocker reaches the agent BEFORE it spends a call discovering the blocker the
 * hard way — which is exactly how the 2026-09-20 dogfood session concluded that
 * entity deletion was impossible and told the user so.
 *
 * FILTERED BY SEVERITY, SURFACED WITH `surface`. "Filter to the door the agent
 * is about to use" is not knowable here — orient runs before the agent has
 * chosen a door. So every row carries its own `surface` and the agent matches
 * it. That is honest; guessing the door would drop findings that apply.
 *
 * Pod-wide on purpose: `finding` is a pod-scoped kind, and a defect in the MCP
 * surface is not a fact about the workspace lens the caller happens to hold.
 *
 * A failed read is `{ status: "unavailable" }` — NEVER an empty list. "No open
 * blockers" and "could not check for blockers" are different facts, and folding
 * the second into the first is how a broken lookup renders as a calm, confident
 * all-clear.
 */
async function readOpenFindings(
  userId: string
): Promise<StartHere["openFindings"]> {
  try {
    const { readOpenBlockerFindings, OPEN_FINDINGS_READ_CAP } =
      await import("./open-findings-door.js");
    const rows = await readOpenBlockerFindings(userId);
    const shown = rows.slice(0, OPEN_FINDINGS_READ_CAP);
    return {
      count: shown.length,
      countIsLowerBound: rows.length > OPEN_FINDINGS_READ_CAP,
      items: shown.map((r) => {
        const props = (r.properties ?? {}) as Record<string, unknown>;
        const surface = props.surface;
        const workaround = props.workaround;
        return {
          id: r.id,
          title: r.title,
          link: openLink(r.id),
          surface: typeof surface === "string" ? surface : null,
          workaround: typeof workaround === "string" ? workaround : null,
        };
      }),
    };
  } catch {
    return UNAVAILABLE;
  }
}

export async function buildStartHere(p: {
  caller: HubProtocolCaller;
  userId: string;
  workspaceId?: string;
  pending: PendingReviewState;
  learnMoreSkill: string;
}): Promise<StartHere> {
  const [openSessions, topKinds, actions, openFindings] = await Promise.all([
    readOpenSessions(p.userId),
    readTopKinds(p),
    readActions(p),
    readOpenFindings(p.userId),
  ]);
  const pendingReview: StartHere["pendingReview"] =
    p.pending.status === "unavailable"
      ? UNAVAILABLE
      : p.pending.count > 0
        ? {
            count: p.pending.count,
            oldestDays: p.pending.oldestDays,
            ...(p.pending.oldestId
              ? { oldestLink: openLink(p.pending.oldestId) }
              : {}),
            lens: "authored",
          }
        : { count: 0, lens: "authored" };
  // Key order is the briefing order — pending review first, then the blockers
  // the agent is about to walk into, then its own open work.
  return {
    pendingReview,
    openFindings,
    openSessions,
    topKinds,
    actions,
    learnMore: { skill: p.learnMoreSkill },
    // THE INSTRUCTION LIVES IN THE POD, NOT IN A PROMPT. This session produced
    // findings only because a human framed the session as dogfooding; an agent
    // doing ordinary work hits the same walls and says nothing, because nothing
    // asked it to. Put the ask where every agent already looks. In a prompt
    // instead, findings arrive only on the days someone remembers to ask —
    // which is the failure this is escaping.
    beforeYouFinish:
      "If something in Synap itself broke, was missing, or cost you a wasted " +
      "call — file it as a `finding` entity before you finish, with VERBATIM " +
      "evidence (the exact error string, the exact failing input, the exact " +
      "receipt line). Never summarise the evidence: a summary is worthless in " +
      "three weeks, a verbatim payload is a ticket. Check `startHere.openFindings` " +
      "first and do not file a twin — findings are deduped by hand today.",
  };
}
