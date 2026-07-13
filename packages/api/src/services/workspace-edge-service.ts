/**
 * Workspace edge-declaration service — the ONE settings-merge helper behind the
 * agnostic "declare an edge on an existing workspace" doors (MCP
 * `synap_declare_workspace_source` + Hub REST
 * `PATCH /workspaces/:workspaceId/source-edges`).
 *
 * Enterprise-OS Wave 0 (the edge substrate). Templates author `sourceRoles`/
 * `defaultSources` at creation time and the tRPC `workspaces.update` UI door can
 * rewrite them, but until now there was NO agnostic door for an agent to DECLARE
 * an edge on an EXISTING workspace. This helper is that write path — and it
 * REUSES the canonical, non-clobbering settings-merge primitive
 * (`WorkspaceRepository.mergeSettings`, the atomic JSONB `||` door the sibling
 * `delivery-preferences` / `eve-provider-routing` endpoints already use) rather
 * than forking workspace-write logic.
 *
 * MERGE, never clobber: it reads the workspace's existing `sourceRoles`/
 * `defaultSources`, spreads the caller's entries OVER them per-domain, and writes
 * ONLY the two edge keys back through `mergeSettings` — every other top-level
 * settings key (aiGovernance, visibility, onboarding, …) is preserved untouched.
 *
 * Governance: this helper does NOT gate — each door asserts the write first
 * (`assertWorkspaceWrite`, the editor+ membership floor keyed off the workspace
 * row) exactly as the other workspace-scoped mutations do, then calls this.
 * Workspace-settings updates have no proposal materializer, so the door gates
 * with membership rather than `checkPermissionOrPropose` (whose proposal would
 * never re-apply the settings on approval) — matching the two sibling
 * settings-merge Hub endpoints.
 */

import { z } from "zod";
import {
  db,
  getDb,
  workspaces,
  eq,
  eventRepository,
  WorkspaceRepository,
  type WorkspaceSourceRole,
  type WorkspaceDefaultSource,
  type WorkspaceSettings,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { createLinks } from "./links/links-service.js";

const logger = createLogger({ module: "workspace-edge-service" });

/** Zod for the edge fields — the ONLY workspace-settings keys these doors write. */
export const WorkspaceDefaultSourceSchema = z.object({
  workspaceId: z.string().uuid(),
  capability: z.string().optional(),
  profileSlug: z.string().optional(),
  label: z.string().optional(),
});

export const WorkspaceSourceEdgeInputSchema = z.object({
  sourceRoles: z
    .record(z.string(), z.enum(["provider", "consumer", "provider-consumer"]))
    .optional(),
  defaultSources: z.record(z.string(), WorkspaceDefaultSourceSchema).optional(),
});

export type WorkspaceSourceEdgeInput = z.infer<
  typeof WorkspaceSourceEdgeInputSchema
>;

export interface WorkspaceSourceEdges {
  sourceRoles: Record<string, WorkspaceSourceRole>;
  defaultSources: Record<string, WorkspaceDefaultSource>;
}

/**
 * Merge `sourceRoles`/`defaultSources` per-domain into a workspace's settings.
 *
 * Read-then-merge on the two edge sub-objects (so a single domain can be added
 * without wiping the others), then one atomic `mergeSettings` write that only
 * touches the provided top-level keys. The caller MUST have authorized the write
 * for `workspaceId` (e.g. via `assertWorkspaceWrite`) before calling.
 *
 * Returns the fully-merged edge maps for the response.
 */
export async function mergeWorkspaceSourceEdges(
  workspaceId: string,
  input: WorkspaceSourceEdgeInput,
  userId: string
): Promise<WorkspaceSourceEdges> {
  const existing = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { settings: true },
  });
  if (!existing) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  const settings = (existing.settings ?? {}) as Record<string, unknown>;
  const currentRoles = (settings.sourceRoles ?? {}) as Record<
    string,
    WorkspaceSourceRole
  >;
  const currentSources = (settings.defaultSources ?? {}) as Record<
    string,
    WorkspaceDefaultSource
  >;

  const mergedRoles: Record<string, WorkspaceSourceRole> = {
    ...currentRoles,
    ...(input.sourceRoles ?? {}),
  };
  const mergedSources: Record<string, WorkspaceDefaultSource> = {
    ...currentSources,
    ...(input.defaultSources ?? {}),
  };

  // Only write the keys the caller actually supplied — a patch that omits one
  // edge map leaves that map (and every other settings key) untouched.
  const patch: Partial<WorkspaceSettings> = {};
  if (input.sourceRoles) patch.sourceRoles = mergedRoles;
  if (input.defaultSources) patch.defaultSources = mergedSources;

  const dbConn = await getDb();
  // Shared singleton — a fresh EventRepository has no registered hooks, so its
  // emitCompleted() append would silently never reach the realtime/sync hooks.
  const workspaceRepo = new WorkspaceRepository(dbConn, eventRepository);
  await workspaceRepo.mergeSettings(workspaceId, patch, userId);

  return { sourceRoles: mergedRoles, defaultSources: mergedSources };
}
