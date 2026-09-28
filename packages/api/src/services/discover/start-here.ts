/**
 * orient's `startHere`, in action order: pending review, open work sessions,
 * sessions owing a grade, most-used kinds, runnable actions, one skill pointer. Each section reads an
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
  type RankedProfile,
} from "./profile-ranking.js";
import type { StartHere } from "./discover.js";

/** Open sessions read before reporting "at least N". */
export const OPEN_SESSIONS_READ_CAP = 10;
/** Sessions handed to the calling agent, listed. */
export const HANDED_TO_YOU_READ_CAP = 5;

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

/**
 * Open sessions owned by the person with THIS agent on the roster. Owner-
 * floored (`focus_sessions` is owner-private); `scheduled` is excluded for the
 * same reason `listOpenFocusSessions` excludes it (future work, not now).
 */
async function readHandedToYou(
  userId: string,
  agentUserId: string
): Promise<NonNullable<StartHere["handedToYou"]>> {
  try {
    const { db, and, eq, inArray, desc, drizzleSql, focusSessions } =
      await import("@synap/database");
    const { OPEN_SESSION_STATUSES } =
      await import("@synap-core/types/focus-sessions");
    const rows = await db
      .select({
        id: focusSessions.id,
        goal: focusSessions.goal,
        startedAt: focusSessions.startedAt,
      })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.userId, userId),
          inArray(
            focusSessions.status,
            OPEN_SESSION_STATUSES.filter((s) => s !== "scheduled")
          ),
          drizzleSql`${agentUserId} = ANY(${focusSessions.agentIds})`
        )
      )
      // SESSION-KIND-LENS-EXEMPT: a roster read for ONE agent — every kind the
      // person put it on is work it was given.
      .orderBy(desc(focusSessions.startedAt))
      .limit(HANDED_TO_YOU_READ_CAP);
    return {
      count: rows.length,
      countIsLowerBound: rows.length >= HANDED_TO_YOU_READ_CAP,
      items: rows.map((r) => ({
        id: r.id,
        goal: r.goal,
        startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
      })),
    };
  } catch {
    return UNAVAILABLE;
  }
}

async function readSessionsOwingGrade(
  userId: string
): Promise<StartHere["sessionsOwingGrade"]> {
  try {
    const { listSessionsOwingGrade } =
      await import("../focus-sessions/session-nudges.js");
    return await listSessionsOwingGrade(userId);
  } catch {
    return UNAVAILABLE;
  }
}

/** A listed profile row as the ranking and the space brief read it. */
export type LensProfile = RankableProfile & {
  profileKind?: string;
  parentProfileId?: string | null;
  uiHints?: unknown;
};

/**
 * THE lens's profile listing, ranked by usage AT that lens — read once and
 * shared by `topKinds` and the space brief's `keyKinds` (a pinned orient
 * computes both from this one read). THROWS on a failed read; each consumer
 * decides how to surface it.
 */
export async function readRankedLensProfiles(p: {
  caller: HubProtocolCaller;
  userId: string;
  workspaceId?: string;
}): Promise<Array<RankedProfile<LensProfile>>> {
  const res = await p.caller.profiles.listProfiles({
    userId: p.userId,
    ...(p.workspaceId ? { workspaceId: p.workspaceId } : {}),
  });
  const profiles = ((res as { profiles?: unknown }).profiles ??
    []) as LensProfile[];
  // Rank the WHOLE listing — so a kind's `rank` is the same number
  // `GET /discover?summary=true` gives it at the same lens.
  const { ranked } = await rankProfilesByUsage({
    userId: p.userId,
    workspaceId: p.workspaceId,
    profiles: profiles.filter((row) => Boolean(row.slug)),
  });
  return ranked;
}

async function readTopKinds(p: {
  caller: HubProtocolCaller;
  userId: string;
  workspaceId?: string;
  ranked?: Promise<Array<RankedProfile<LensProfile>>>;
}): Promise<StartHere["topKinds"]> {
  try {
    const ranked = await (p.ranked ?? readRankedLensProfiles(p));
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
    const { blockers, openTotal } = await readOpenBlockerFindings(userId);
    const shown = blockers.slice(0, OPEN_FINDINGS_READ_CAP);
    return {
      count: shown.length,
      countIsLowerBound: blockers.length > OPEN_FINDINGS_READ_CAP,
      // NAME THE FILTER. `count` is blockers only; `openTotal` is every open
      // finding. Without both, an agent told to "check openFindings before
      // filing" dedupes against a filtered list and files a twin of a `minor`
      // finding while following the instruction exactly (finding 14005d59).
      severity: "blocker" as const,
      openTotal,
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
  /** The calling agent, when an agent key calls — see `handedToYou`. */
  agentUserId?: string | null;
  workspaceId?: string;
  pending: PendingReviewState;
  learnMoreSkill: string;
  /** The lens listing, when the caller already started reading it. */
  ranked?: Promise<Array<RankedProfile<LensProfile>>>;
}): Promise<StartHere> {
  const [
    openSessions,
    sessionsOwingGrade,
    topKinds,
    actions,
    openFindings,
    handedToYou,
  ] = await Promise.all([
      readOpenSessions(p.userId),
      readSessionsOwingGrade(p.userId),
      readTopKinds(p),
      readActions(p),
      readOpenFindings(p.userId),
      p.agentUserId
        ? readHandedToYou(p.userId, p.agentUserId)
        : Promise.resolve(undefined),
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
    ...(handedToYou ? { handedToYou } : {}),
    sessionsOwingGrade,
    topKinds,
    actions,
    learnMore: { skill: p.learnMoreSkill },
    // ROUTING (founder, 2026-09-28): product problems go to the Synap TEAM via
    // the CP MCP `report_to_synap` tool (synap-control-plane-api
    // lib/agent-tickets.ts); only what THIS user must act on is a `finding`.
    // THE INSTRUCTION LIVES IN THE POD, NOT IN A PROMPT. This session produced
    // findings only because a human framed the session as dogfooding; an agent
    // doing ordinary work hits the same walls and says nothing, because nothing
    // asked it to. Put the ask where every agent already looks. In a prompt
    // instead, findings arrive only on the days someone remembers to ask —
    // which is the failure this is escaping.
    beforeYouFinish:
      "Before you finish, report what got in your way — routed by WHO must " +
      "act. (1) Synap ITSELF broke, was missing, cost you a wasted call or a " +
      "workaround, or you have an idea for the product: that is for the Synap " +
      "team — call `report_to_synap` on the Synap Control Plane connector " +
      "(no connector? tell the user what to report). (2) Something about THIS " +
      "user's data or setup — duplicates, missing grants or keys, their " +
      "config: that is theirs — file a `finding` entity here. Either way " +
      "quote VERBATIM evidence (the exact error string, failing input, " +
      "receipt line): a summary is worthless in three weeks. Before filing a " +
      "`finding`, dedupe against ALL open findings — " +
      "`startHere.openFindings.items` is the BLOCKER page only (`openTotal` " +
      "counts every severity), so list the rest with the entity-listing tool " +
      'this door exposes (`profileSlug: "finding"`).',
  };
}
