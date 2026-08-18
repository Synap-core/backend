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
  eventRepository,
  workspaces,
  eq,
} from "@synap/database";
import type { RendererRef } from "@synap/database";
import { TRPCError } from "@trpc/server";

/** The wire-level slot names external agents use. */
export type RendererSlot = "list" | "detail" | "card" | "dashboard";
export type RendererScope = "workspace" | "pod";

/** slot → ContentKind (the canonical taxonomy used by workspace overlays). */
const SLOT_TO_CONTENT_KIND: Record<RendererSlot, string> = {
  list: "collection",
  detail: "entity-detail",
  card: "entity-card",
  dashboard: "entity-profile",
};

/**
 * The deprecated singular column a slot ALSO writes, for back-compat with rows
 * that predate `default_renderers` (migration 0112). `card` is deliberately
 * absent: `entity-card` is newer than the column era, so it has no legacy
 * column and lives ONLY in the `default_renderers` map. Written as a lookup
 * rather than a ternary chain because a chain's final `else` silently swallows
 * any slot added later — which is exactly how `card` would have landed in
 * `defaultDashboardRenderer`.
 */
const LEGACY_COLUMN_BY_SLOT: Partial<Record<RendererSlot, string>> = {
  list: "defaultListRenderer",
  detail: "defaultDetailRenderer",
  dashboard: "defaultDashboardRenderer",
};

export interface SetProfileRendererInput {
  userId: string;
  /** Required for `scope: 'workspace'`; also used to resolve the profile lens. */
  workspaceId: string | null;
  profileSlug: string;
  slot: RendererSlot;
  /** `null` clears a workspace override; pod defaults cannot be cleared here. */
  ref: RendererRef | null;
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
    if (ref === null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Pod-scoped profile renderer defaults cannot be cleared",
      });
    }
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
    const legacyColumn = LEGACY_COLUMN_BY_SLOT[slot];
    const patch = {
      ...(legacyColumn ? { [legacyColumn]: ref } : {}),
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
  // Shared singleton — a fresh EventRepository has no registered hooks, so
  // its emitCompleted() append would silently never reach the
  // realtime/materialization/sync hooks.
  const eventRepo = eventRepository;
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
  if (ref === null) {
    delete profileEntry[contentKind];
  } else {
    profileEntry[contentKind] = ref;
  }
  const nextProfileRenderers: Record<
    string,
    Record<string, RendererRef | undefined>
  > = { ...current, [profileSlug]: profileEntry };

  if (Object.keys(profileEntry).length === 0) {
    delete nextProfileRenderers[profileSlug];
  }

  await workspaceRepo.mergeSettings(
    workspaceId,
    { profileRenderers: nextProfileRenderers },
    userId
  );
}
