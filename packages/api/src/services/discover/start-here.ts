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

export async function buildStartHere(p: {
  caller: HubProtocolCaller;
  userId: string;
  workspaceId?: string;
  pending: PendingReviewState;
  learnMoreSkill: string;
}): Promise<StartHere> {
  const [openSessions, topKinds, actions] = await Promise.all([
    readOpenSessions(p.userId),
    readTopKinds(p),
    readActions(p),
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
  // Key order is the briefing order — pending review first.
  return {
    pendingReview,
    openSessions,
    topKinds,
    actions,
    learnMore: { skill: p.learnMoreSkill },
  };
}
