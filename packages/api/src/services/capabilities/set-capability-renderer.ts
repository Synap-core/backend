/**
 * Set a capability's renderer page-set — the shared write path.
 *
 * SINGLE SOURCE OF TRUTH used by BOTH the governed tRPC route (operator
 * auto-apply) AND the `capability/renderer.set` proposal executor (agent
 * proposal → materialize on approval). The capability-subject clone of
 * `set-profile-renderer.ts`, one subject over:
 *   - workspace overlay → workspaces.settings.capabilityRenderers[capabilityId]
 *   - capability default → capabilities.metadata.renderers
 *
 * Resolution lives in `getEffectiveCapabilityRenderer` (@synap/database).
 */

import {
  getDb,
  WorkspaceRepository,
  eventRepository,
  capabilities,
  workspaces,
  eq,
} from "@synap/database";
import type { CapabilityRendererPage } from "@synap/database";
import { TRPCError } from "@trpc/server";

export type CapabilityRendererScope = "workspace" | "capability";

export interface SetCapabilityRendererInput {
  userId: string;
  /** Required for `scope: 'workspace'`. */
  workspaceId: string | null;
  capabilityId: string;
  /**
   * The ORDERED page-set to bind. An empty array CLEARS the binding for the
   * scope (workspace overlay key removed; capability default emptied) so the
   * next layer answers — never a `{ pages: [] }` sentinel left behind.
   */
  pages: CapabilityRendererPage[];
  scope: CapabilityRendererScope;
}

/**
 * Apply a capability renderer write. Caller MUST gate first
 * (checkPermissionOrPropose).
 */
export async function setCapabilityRenderer(
  input: SetCapabilityRendererInput
): Promise<void> {
  const { userId, workspaceId, capabilityId, pages, scope } = input;
  const db = await getDb();

  if (scope === "capability") {
    // Capability default: capabilities.metadata.renderers = { pages }.
    const [capability] = await db
      .select({ metadata: capabilities.metadata })
      .from(capabilities)
      .where(eq(capabilities.id, capabilityId))
      .limit(1);
    if (!capability) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Capability '${capabilityId}' not found`,
      });
    }
    const currentMetadata = (capability.metadata ?? {}) as Record<
      string,
      unknown
    >;
    // Plain-object JSONB assignment — the established capability-metadata write
    // pattern (see create-from-definition.ts): read the row, merge in JS, set.
    const nextMetadata = { ...currentMetadata };
    if (pages.length === 0) {
      delete nextMetadata.renderers;
    } else {
      nextMetadata.renderers = { pages };
    }
    await db
      .update(capabilities)
      .set({ metadata: nextMetadata, updatedAt: new Date() })
      .where(eq(capabilities.id, capabilityId));
    return;
  }

  // Workspace overlay: workspaces.settings.capabilityRenderers[capabilityId].
  if (!workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "workspaceId is required for a workspace-scoped renderer",
    });
  }
  // Shared singleton — a fresh EventRepository has no registered hooks, so its
  // emitCompleted() would silently never reach realtime/materialization/sync.
  const eventRepo = eventRepository;
  const workspaceRepo = new WorkspaceRepository(db, eventRepo);

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { settings: true },
  });
  if (!workspace) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
  }

  const settings = (workspace.settings ?? {}) as Record<string, unknown>;
  const current = (settings.capabilityRenderers ?? {}) as Record<
    string,
    { pages: CapabilityRendererPage[] }
  >;
  const next: Record<string, { pages: CapabilityRendererPage[] }> = {
    ...current,
  };
  if (pages.length === 0) {
    delete next[capabilityId];
  } else {
    next[capabilityId] = { pages };
  }

  // mergeSettings overwrites top-level keys — build the full capabilityRenderers
  // map and pass it as one key (mirrors set-profile-renderer's profileRenderers).
  await workspaceRepo.mergeSettings(
    workspaceId,
    { capabilityRenderers: next },
    userId
  );
}
