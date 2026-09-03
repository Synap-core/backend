/**
 * Set a profile's renderer — the shared write path.
 *
 * SINGLE SOURCE OF TRUTH used by BOTH the governed Hub route (operator
 * auto-apply) AND the `profile/renderer.set` proposal executor (agent proposal
 * → materialize on approval), plus the tRPC override door and MCP
 * `synap_promote_cell_to_renderer`.
 *
 * WHAT THIS WRITES (K2). The canonical store is now `renderer_bindings` — the
 * ONE table `ProfileResolutionService.getEffectiveRendererWithSource` reads at
 * layer 0, ABOVE the three legacy stores. Every call writes a binding through
 * `setRendererBinding` / `revokeRendererBinding` (`@synap/database`), which is
 * the only insert path into that table.
 *
 * LEGACY MIRROR — DECIDED, TIME-BOXED, NOT SILENT. For ONE release this door
 * ALSO keeps writing the legacy store a given scope used to own:
 *   - `scope: 'workspace'` → `workspaces.settings.profileRenderers[slug][kind]`
 *   - `scope: 'pod'`       → `profiles.defaultRenderers` + the deprecated
 *                            `default_(list|detail|dashboard)_renderer` column
 * so that a reader which has NOT been moved to the binding rung (an older pod
 * build, the frontend's own cached workspace settings) does not regress the
 * moment this lands. The mirror is gated on ONE named flag,
 * {@link MIRROR_LEGACY_RENDERER_STORES}, so retiring it is a one-line change
 * and not an archaeology exercise. It is deliberately NOT written for the two
 * shapes the legacy stores cannot express — `scope: 'user'` and ANY
 * `subjectId` (per-object) binding — because there is no legacy key for them,
 * and inventing one would fork the store this table exists to unify.
 *
 * Mirrors the two pre-existing tRPC write paths it subsumes:
 *   - workspace overlay → `profiles.setProfileRendererOverride`
 *   - pod system default → `profiles.update` defaults( list|detail|dashboard )Renderer.
 */

import {
  getDb,
  ProfileRepository,
  ProfileResolutionService,
  WorkspaceRepository,
  eventRepository,
  revokeRendererBinding,
  setRendererBinding,
  workspaces,
  eq,
} from "@synap/database";
import type { RendererRef } from "@synap/database";
import { TRPCError } from "@trpc/server";

import { assertMayBindRenderer } from "./renderer-binding-authz.js";
import {
  SLOT_TO_CONTENT_KIND,
  type RendererScope,
  type RendererSlot,
} from "./renderer-slots.js";

/**
 * The slot/scope vocabularies live in their own dependency-free module
 * (`renderer-slots.ts`) so a wire schema can import the enum without pulling in
 * this write path. Re-exported here for the existing callers that already
 * import them from this module.
 */
export {
  RENDERER_SLOTS,
  RENDERER_SCOPES,
  type RendererSlot,
  type RendererScope,
} from "./renderer-slots.js";

/**
 * Keep writing the pre-`renderer_bindings` stores alongside the binding, for
 * one release, so un-migrated readers do not regress. Flip to `false` (and then
 * delete the branches it guards) once every reader resolves through
 * `getEffectiveRendererWithSource`.
 */
export const MIRROR_LEGACY_RENDERER_STORES = true;

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
  /** `null` clears the binding (and a workspace overlay); see the pod caveat below. */
  ref: RendererRef | null;
  scope: RendererScope;
  /**
   * Bind for ONE object rather than the whole kind. A GOVERNED EXCEPTION: the
   * default is kind-level, and a per-object binding reaches the store through
   * the same gate as any other write.
   */
  subjectId?: string | null;
  /** Set when a proposal approval materialized this write — kept as lineage. */
  sourceProposalId?: string | null;
}

/**
 * Apply a profile renderer write.
 *
 * Caller MUST have gated on intent first (`checkPermissionOrPropose` — agent
 * vs operator). This function additionally enforces the per-scope ROLE floor
 * (`assertMayBindRenderer`), which is a different question and was previously
 * unasked for `scope: 'pod'`.
 */
export async function setProfileRenderer(
  input: SetProfileRendererInput
): Promise<void> {
  const {
    userId,
    workspaceId,
    profileSlug,
    slot,
    ref,
    scope,
    subjectId = null,
    sourceProposalId = null,
  } = input;
  const db = await getDb();
  const contentKind = SLOT_TO_CONTENT_KIND[slot] as
    "collection" | "entity-detail" | "entity-card" | "entity-profile";

  await assertMayBindRenderer({ userId, scope, workspaceId });

  // A pod default has no "cleared" state in the legacy store (the column and
  // the map both fall through to the hardcoded system fallback, which is a
  // different thing from "unset"). Refused for the kind-level pod write, which
  // is the one the legacy store still answers; a per-object or user binding is
  // freely revocable because only the binding table holds it.
  if (ref === null && scope === "pod" && subjectId === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Pod-scoped profile renderer defaults cannot be cleared",
    });
  }
  if (scope === "workspace" && !workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "workspaceId is required for a workspace-scoped renderer",
    });
  }

  // ── 1. The canonical store: renderer_bindings ────────────────────────────
  const bindingKey = {
    scopeKind: scope,
    userId: scope === "user" ? userId : null,
    workspaceId: scope === "workspace" ? workspaceId : null,
    subjectKind: profileSlug,
    subjectId,
    contentKind,
  } as const;

  if (ref === null) {
    await revokeRendererBinding(db, { ...bindingKey, actorUserId: userId });
  } else {
    await setRendererBinding(db, {
      ...bindingKey,
      ref,
      sourceProposalId,
      actorUserId: userId,
    });
  }

  // ── 2. Legacy mirror (one release; see MIRROR_LEGACY_RENDERER_STORES) ─────
  // Skipped for the two shapes no legacy store can express.
  if (!MIRROR_LEGACY_RENDERER_STORES) return;
  if (scope === "user" || subjectId !== null) return;

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
  if (!workspaceId) return;
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
