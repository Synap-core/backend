/**
 * THE ONE ranking of profile rows by use — shared by the discover summary tier
 * (`GET /discover`) and orient's `startHere.topKinds`, so the kinds an agent is
 * briefed with and the order the inventory lists them in can never disagree.
 *
 * Inputs are the rows a LISTING door already returned (so a caller can never
 * rank a profile it cannot list) plus THE usage aggregate
 * (`usage-aggregate.ts`), floored on the authenticated user and narrowed to the
 * workspaces they can access — never a request-supplied id alone.
 *
 * Provenance (`origin`) comes from `resolveProfileOrigin`
 * (`utils/profile-presentation.ts`); the install template/package is read only
 * for workspaces the caller can access.
 */

import { db, workspaces, inArray } from "@synap/database";
import { humanizeToken } from "@synap-core/types/vocabulary";
import { getUserAccessibleWorkspaceIds } from "../../routers/hub-protocol/rest/_shared.js";
import {
  resolveProfileOrigin,
  type ResolvedProfileOrigin,
  type StoredProfileOriginSource,
  type WorkspaceInstallSource,
} from "../../utils/profile-presentation.js";
import {
  loadEntityUsage,
  rankByUsage,
  usageByProfile,
} from "./usage-aggregate.js";

export interface RankableProfile extends StoredProfileOriginSource {
  id?: string;
  slug: string;
  displayName?: string;
  name?: string;
}

export interface RankedProfile<P extends RankableProfile> {
  profile: P;
  /** 1-based; every listed row has one (unused rows trail, by name). */
  rank: number;
  score: number;
  entityCount: number;
  lastActivityAt: string | null;
  origin: ResolvedProfileOrigin;
}

/** A presentation grouping. References rows by id; never nests them. */
export interface ProfileGroup {
  key: string;
  label: string;
  profileIds: string[];
}

/** Rows in the "used most" group — the same window orient briefs with. */
export const USED_MOST_LIMIT = 8;

export function profileDisplayName(p: RankableProfile): string {
  return p.displayName ?? p.name ?? p.slug;
}

/**
 * PURE: the groups for an already-ranked list. `used` first (rank order, only
 * rows with any usage), then one group per placement (`origin.group`) — core,
 * shared, each workspace (labelled by its name when the caller can see it),
 * unknown. Empty groups are omitted; rows without an id are skipped.
 */
export function groupRankedProfiles<P extends RankableProfile>(
  ranked: ReadonlyArray<RankedProfile<P>>,
  workspaceName: (id: string) => string | undefined
): ProfileGroup[] {
  const groups: ProfileGroup[] = [];
  const used = ranked
    .filter((r) => r.score > 0 && r.profile.id)
    .slice(0, USED_MOST_LIMIT)
    .map((r) => r.profile.id!);
  if (used.length)
    groups.push({ key: "used", label: "Used most", profileIds: used });

  const byOrigin = new Map<string, ProfileGroup>();
  for (const r of ranked) {
    if (!r.profile.id) continue;
    const { group, workspaceId } = r.origin;
    const key = group === "workspace" ? `workspace:${workspaceId}` : group;
    let g = byOrigin.get(key);
    if (!g) {
      g = {
        key,
        label:
          group === "workspace"
            ? (workspaceName(workspaceId!) ?? humanizeToken(group))
            : humanizeToken(group),
        profileIds: [],
      };
      byOrigin.set(key, g);
    }
    g.profileIds.push(r.profile.id);
  }
  const tierOrder = (key: string) =>
    key === "core" ? 0 : key === "shared" ? 1 : key === "unknown" ? 3 : 2;
  return [
    ...groups,
    ...[...byOrigin.values()].sort(
      (a, b) =>
        tierOrder(a.key) - tierOrder(b.key) || a.label.localeCompare(b.label)
    ),
  ];
}

export async function rankProfilesByUsage<P extends RankableProfile>(params: {
  /** The AUTHENTICATED user — the floor. Never a request body/query id. */
  userId: string;
  /** Optional lens; narrows to it only when the user can access it. */
  workspaceId?: string;
  profiles: readonly P[];
  now?: Date;
}): Promise<{ ranked: Array<RankedProfile<P>>; groups: ProfileGroup[] }> {
  const { userId, workspaceId, profiles } = params;
  const accessible = await getUserAccessibleWorkspaceIds(userId);
  const lens = workspaceId
    ? accessible.filter((id) => id === workspaceId)
    : accessible;

  const usage = usageByProfile(
    await loadEntityUsage({
      userId,
      workspaceIds: lens,
      includePodScoped: true,
      withOpens: true,
    })
  );

  const accessibleSet = new Set(accessible);
  const profileWsIds = [
    ...new Set(
      profiles
        .map((p) => (p.scope === "workspace" ? p.workspaceId : null))
        .filter((id): id is string => !!id && accessibleSet.has(id))
    ),
  ];
  const wsRows = profileWsIds.length
    ? await db
        .select({
          id: workspaces.id,
          name: workspaces.name,
          settings: workspaces.settings,
          packageSlug: workspaces.packageSlug,
        })
        .from(workspaces)
        .where(inArray(workspaces.id, profileWsIds))
    : [];
  const wsById = new Map(wsRows.map((w) => [w.id, w]));
  const install = (id: string): WorkspaceInstallSource | undefined => {
    const w = wsById.get(id);
    if (!w) return undefined;
    const s = (w.settings ?? {}) as Record<string, unknown>;
    return {
      templateId: typeof s.templateId === "string" ? s.templateId : null,
      packageSlug:
        (typeof s.packageSlug === "string" ? s.packageSlug : null) ??
        w.packageSlug ??
        null,
    };
  };

  const ranked = rankByUsage(profiles, {
    idOf: (p) => p.id,
    nameOf: profileDisplayName,
    usage,
    now: params.now,
  }).map((r): RankedProfile<P> => ({
    profile: r.item,
    rank: r.rank,
    score: r.score,
    entityCount: r.usage?.count ?? 0,
    lastActivityAt: r.usage?.lastActivityAt?.toISOString() ?? null,
    origin: resolveProfileOrigin(r.item, install),
  }));

  return {
    ranked,
    groups: groupRankedProfiles(ranked, (id) => wsById.get(id)?.name),
  };
}
