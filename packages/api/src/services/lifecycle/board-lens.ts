/**
 * The ONE resolution of a pipeline lens — moved out of `routers/lifecycle.ts`
 * so the homes reads (`services/lifecycle/homes.ts`) resolve a (space, kind)
 * exactly as the board that door opens does: same declared lifecycle, same
 * access-layer conditions, same grouping subject. Never a second copy.
 */
import { TRPCError } from "@trpc/server";
import {
  db,
  ProfileResolutionService,
  type EffectiveLifecycle,
} from "@synap/database";
import {
  lifecycleOptionLabel,
  lifecycleOptionTone,
} from "@synap-core/types/lifecycle";
import type { LifecycleWire } from "../../routers/lifecycle.js";
import { assertKnownProfileSlug } from "../../utils/assert-known-profile-slug.js";
import { getTrack } from "../tracks/tracks-service.js";
import {
  kindVisibilityConditions,
  roleVisibilityConditions,
  statusSubjectOfRows,
} from "./status-groups.js";

export interface ResolvedProfile {
  profileKind: "kind" | "role";
  profileIds: string[];
  podScopeKind: boolean;
  lifecycle: EffectiveLifecycle;
}

/**
 * The slug → its rows of ONE kind (a role row wins: a slug that is a role
 * groups facets) and the effective lifecycle of the first row that declares
 * one. No declaration → PRECONDITION_FAILED naming the fix (a lifecycle is
 * declared once, on the profile — never guessed from a select's name).
 */
export async function resolveProfileLifecycle(
  profileSlug: string,
  workspaceId: string | null | undefined
): Promise<ResolvedProfile> {
  const rows = await assertKnownProfileSlug(db, profileSlug);
  const { chosen, profileKind, podScopeKind } = statusSubjectOfRows(
    profileSlug,
    rows
  );
  const resolver = new ProfileResolutionService(db);
  let lifecycle: EffectiveLifecycle | null = null;
  for (const r of chosen) {
    lifecycle = await resolver.getEffectiveLifecycle(r.id, workspaceId ?? null);
    if (lifecycle) break;
  }
  if (!lifecycle || lifecycle.options.length === 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        `"${profileSlug}" has no declared lifecycle, so it has no pipeline. ` +
        `Declare one on the profile (lifecycle: { property, options: [{ key, category }] }) ` +
        `— categories are open · active · paused · done · lost.`,
    });
  }
  return {
    profileKind,
    profileIds: chosen.map((r) => r.id),
    podScopeKind,
    lifecycle,
  };
}

export function toLifecycleWire(
  profileSlug: string,
  p: ResolvedProfile
): LifecycleWire {
  return {
    profileSlug,
    profileKind: p.profileKind,
    property: p.lifecycle.propertySlug,
    options: p.lifecycle.options.map((o) => ({
      key: o.key,
      label: lifecycleOptionLabel(o),
      category: o.category,
      tone: lifecycleOptionTone(o),
      humanOnly: o.humanOnly === true,
      ...(o.stuckAfterDays !== undefined
        ? { stuckAfterDays: o.stuckAfterDays }
        : {}),
    })),
  };
}

/**
 * ONE resolution of a pipeline lens: the track → its project, the workspace
 * three-state, the declared lifecycle, the access-layer visibility conditions
 * and the grouping subject. `board` and `throughput` read through it, so the
 * goal line can never count things the board does not show.
 */
export async function resolveBoardLens(
  input: {
    profileSlug: string;
    projectId?: string;
    trackId?: string;
    workspaceId?: string | null;
  },
  ctx: { userId: string; workspaceId?: string | null }
) {
  let projectId = input.projectId;
  if (input.trackId) {
    const track = await getTrack(input.trackId, {
      userId: ctx.userId,
      agentUserId: (ctx as { agentUserId?: string | null }).agentUserId,
    });
    if (!track) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Track not found",
      });
    }
    if (projectId && projectId !== track.projectId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "trackId belongs to another project than projectId.",
      });
    }
    projectId = track.projectId;
  }
  const lensWorkspaceId =
    input.workspaceId !== undefined
      ? input.workspaceId
      : (ctx.workspaceId ?? undefined);
  const p = await resolveProfileLifecycle(input.profileSlug, lensWorkspaceId);
  const lifecycle = toLifecycleWire(input.profileSlug, p);

  const conditions =
    p.profileKind === "role"
      ? await roleVisibilityConditions({
          userId: ctx.userId,
          lensWorkspaceId,
          projectId,
        })
      : kindVisibilityConditions({
          userId: ctx.userId,
          lensWorkspaceId,
          explicitWorkspace: input.workspaceId !== undefined,
          projectId,
          podScopeKind: p.podScopeKind,
        });
  const subject =
    p.profileKind === "role"
      ? {
          kind: "role" as const,
          profileIds: p.profileIds,
          roleSlug: input.profileSlug,
        }
      : { kind: "kind" as const, profileIds: p.profileIds };
  return { projectId, p, lifecycle, conditions, subject };
}

export type BoardLens = Awaited<ReturnType<typeof resolveBoardLens>>;
