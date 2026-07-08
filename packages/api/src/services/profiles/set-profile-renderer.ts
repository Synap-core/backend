/**
 * Set a profile's renderer — the shared write path.
 *
 * SINGLE SOURCE OF TRUTH used by BOTH the governed Hub route (operator
 * auto-apply) AND the `profile/renderer.set` proposal executor (agent proposal
 * → materialize on approval). Mirrors the two existing tRPC write paths:
 *   - workspace overlay → `profiles.setProfileRendererOverride`
 *     (workspaces.settings.profileRenderers[slug][contentKind])
 *   - pod system default → `profiles.update` defaults( list|detail|dashboard )Renderer.
 */

import {
  getDb,
  ProfileRepository,
  ProfileResolutionService,
  WorkspaceRepository,
  EventRepository,
  workspaces,
  eq,
  sql,
} from "@synap/database";
import type { RendererRef } from "@synap/database";
import { TRPCError } from "@trpc/server";

/** The wire-level slot names external agents use. */
export type RendererSlot = "list" | "detail" | "dashboard";
export type RendererScope = "workspace" | "pod";

/** slot → ContentKind (the canonical taxonomy used by workspace overlays). */
const SLOT_TO_CONTENT_KIND: Record<RendererSlot, string> = {
  list: "collection",
  detail: "entity-detail",
  dashboard: "entity-profile",
};

export interface SetProfileRendererInput {
  userId: string;
  /** Required for `scope: 'workspace'`; also used to resolve the profile lens. */
  workspaceId: string | null;
  profileSlug: string;
  slot: RendererSlot;
  ref: RendererRef;
  scope: RendererScope;
}

/**
 * Apply a profile renderer write. Caller MUST gate first (checkPermissionOrPropose).
 */
export async function setProfileRenderer(
  input: SetProfileRendererInput
): Promise<void> {
  const { userId, workspaceId, profileSlug, slot, ref, scope } = input;
  const db = await getDb();

  if (scope === "pod") {
    // System default: profiles.default_{list,detail,dashboard}_renderer.
    const profileRepo = new ProfileRepository(db);
    const resolutionService = new ProfileResolutionService(db);
    const profile = await resolutionService.resolveProfile(
      profileSlug,
      userId,
      workspaceId
    );
    if (!profile) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Profile '${profileSlug}' not found`,
      });
    }
    const contentKind = SLOT_TO_CONTENT_KIND[slot];
    const currentDefaultRenderers = (profile.defaultRenderers ?? {}) as Record<
      string,
      RendererRef | undefined
    >;
    const patch = {
      ...(slot === "list"
        ? { defaultListRenderer: ref }
        : slot === "detail"
          ? { defaultDetailRenderer: ref }
          : { defaultDashboardRenderer: ref }),
      defaultRenderers: { ...currentDefaultRenderers, [contentKind]: ref },
    };
    await profileRepo.update(profile.id, patch);
    return;
  }

  // Workspace overlay: workspaces.settings.profileRenderers[slug][contentKind].
  if (!workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "workspaceId is required for a workspace-scoped renderer",
    });
  }
  const contentKind = SLOT_TO_CONTENT_KIND[slot];
  const eventRepo = new EventRepository(sql);
  const workspaceRepo = new WorkspaceRepository(db, eventRepo);

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  });
  if (!workspace) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
  }

  const settings = (workspace.settings ?? {}) as Record<string, unknown>;
  const current = (settings.profileRenderers ?? {}) as Record<
    string,
    Record<string, RendererRef | undefined>
  >;
  const profileEntry = { ...(current[profileSlug] ?? {}) };
  profileEntry[contentKind] = ref;
  const nextProfileRenderers: Record<
    string,
    Record<string, RendererRef | undefined>
  > = { ...current, [profileSlug]: profileEntry };

  await workspaceRepo.mergeSettings(
    workspaceId,
    { profileRenderers: nextProfileRenderers },
    userId
  );
}
