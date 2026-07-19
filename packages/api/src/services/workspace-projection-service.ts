/**
 * Workspace public-projection service — the ONE settings-merge helper behind the
 * agnostic "set the public-projection config on an existing workspace" door (Hub
 * REST `PATCH /workspaces/:workspaceId/public-projection`).
 *
 * A workspace can opt in to an UNAUTHENTICATED public projection of its
 * facet-scoped data (served by the read-side `GET /public/projection` route).
 * Until now there was NO agnostic door for an agent (or a member whose role
 * lacks `write`) to SET that config on an EXISTING workspace. This helper is
 * that write path — and it REUSES the canonical, non-clobbering settings-merge
 * primitive (`WorkspaceRepository.mergeSettings`, the atomic JSONB `||` door the
 * sibling `delivery-preferences` / `source-edges` endpoints already use) rather
 * than forking workspace-write logic.
 *
 * MERGE, never clobber: it reads the workspace's existing settings, writes ONLY
 * the single `publicProjection` top-level key back through `mergeSettings`, and
 * every other top-level settings key (aiGovernance, visibility, sourceRoles,
 * onboarding, …) is preserved untouched.
 *
 * Governance: this helper does NOT gate — it is the APPLY function. The door
 * gates FIRST via `checkPermissionOrPropose({ subjectType:"workspace",
 * action:"configure_public_projection" })`. On a GRANT (operator authority /
 * whitelisted agent) the door calls this immediately; on a PROPOSE the door
 * returns the proposal and this runs later, as the approver, from the
 * `workspace/configure_public_projection` proposal executor
 * (routers/proposals/approve-executors.ts). Either way the caller has already
 * authorized the write for `workspaceId` before calling.
 *
 * Product-agnostic: the config names no product, role, or field literally — the
 * workspace owner declares WHICH facet role-profiles are public (`roles`) and
 * WHICH property keys may be projected (`fields`).
 */

import { z } from "zod";
import {
  db,
  getDb,
  workspaces,
  eq,
  eventRepository,
  WorkspaceRepository,
  type PublicProjectionSettings,
  type WorkspaceSettings,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "workspace-projection-service" });

/** Zod for the public-projection config — the ONLY settings key this door writes. */
export const PublicProjectionInputSchema = z.object({
  /** Master switch. Anything other than `true` = not opted in = read route 404s. */
  enabled: z.boolean(),
  /**
   * Allowlist of facet role-profile slugs whose holders are public. At least one
   * is required — an empty list means nothing is public, which is the implicit
   * default; callers that want to disable should set `enabled: false` instead.
   */
  roles: z.array(z.string().min(1)).min(1),
  /** Allowlist of property keys that may appear in a projected row. */
  fields: z.array(z.string().min(1)).default([]),
});

export type PublicProjectionInput = z.infer<typeof PublicProjectionInputSchema>;

/**
 * Set a workspace's `publicProjection` config, merged into its existing settings.
 *
 * Read-then-write: reads existing settings only to assert the workspace exists,
 * then one atomic `mergeSettings` write that touches ONLY the `publicProjection`
 * top-level key — every other settings key is preserved via the JSONB `||`
 * merge. The caller MUST have authorized the write for `workspaceId` (e.g. via
 * `checkPermissionOrPropose`) before calling.
 *
 * Returns the config that was written for the response.
 */
export async function setWorkspacePublicProjection(
  workspaceId: string,
  input: PublicProjectionInput,
  actorUserId: string
): Promise<PublicProjectionSettings> {
  const existing = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { settings: true },
  });
  if (!existing) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  const projection: PublicProjectionSettings = {
    enabled: input.enabled,
    roles: input.roles,
    fields: input.fields,
  };

  // Only write the single `publicProjection` key — mergeSettings' atomic JSONB
  // `||` preserves every other top-level settings key untouched.
  const patch: Partial<WorkspaceSettings> = { publicProjection: projection };

  const dbConn = await getDb();
  // Shared singleton — a fresh EventRepository has no registered hooks, so its
  // emitCompleted() append would silently never reach the realtime/sync hooks.
  const workspaceRepo = new WorkspaceRepository(dbConn, eventRepository);
  await workspaceRepo.mergeSettings(workspaceId, patch, actorUserId);

  logger.info(
    { workspaceId, enabled: projection.enabled, roleCount: projection.roles.length },
    "workspace public-projection config set"
  );

  return projection;
}
