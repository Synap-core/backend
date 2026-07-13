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
 * Governance: this helper does NOT gate — it is the APPLY function. Each door
 * gates FIRST via `checkPermissionOrPropose({ subjectType:"workspace",
 * action:"declare_source" })` (Enterprise-OS Wave 0 made this a governed write,
 * because declaring an edge rewires pod-wide cross-workspace read routing). On a
 * GRANT (operator authority / whitelisted agent) the door calls this immediately;
 * on a PROPOSE the door returns the proposal and this runs later, as the approver,
 * from the `workspace/declare_source` proposal executor
 * (routers/proposals/approve-executors.ts). Either way the caller has already
 * authorized the write for `workspaceId` before calling.
 */

import { z } from "zod";
import {
  db,
  getDb,
  workspaces,
  links,
  eq,
  and,
  ne,
  drizzleSql,
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

  // Close the loop: materialize each declared `defaultSources[domain]` as the
  // `provider --feeds--> consumer` link the PLACEMENT ladder's rung-4 reads
  // (`loadFeedsProviders`), so a freshly-declared edge is live immediately —
  // NOT dormant until the manual `backfill-default-sources-edges` script runs.
  // Best-effort: `settings.defaultSources` is the source of truth (the IS
  // resolver reads it directly); the link is a placement optimization, so a
  // link hiccup must not lose the settings write. `createLinks` dedups on the
  // (from,to,type) edge (ON CONFLICT DO NOTHING), so re-declaring is idempotent.
  if (input.defaultSources) {
    try {
      const entries = Object.entries(input.defaultSources);
      // Retire the stale edge for a re-declared domain: when a domain's provider
      // is reassigned (A→B), the old `A --feeds--> consumer` link must be removed
      // so the materialized graph keeps mirroring `settings.defaultSources` 1:1 —
      // otherwise `loadFeedsProviders` returns BOTH A and B forever.
      for (const [domain, source] of entries) {
        await db
          .delete(links)
          .where(
            and(
              eq(links.toType, "workspace"),
              eq(links.toId, workspaceId),
              eq(links.linkType, "feeds"),
              drizzleSql`${links.metadata}->>'domain' = ${domain}`,
              ne(links.fromId, source.workspaceId)
            )
          );
      }
      const feedsLinks = entries.map(([domain, source]) => ({
        workspaceId,
        fromType: "workspace" as const,
        fromId: source.workspaceId,
        toType: "workspace" as const,
        toId: workspaceId,
        linkType: "feeds" as const,
        // `profileSlug` scopes the edge to ONE kind — `loadFeedsProviders` reads
        // `metadata->>'profileSlug'` to decide kind-qualified vs domain-wide, so
        // it MUST be carried or every declared edge becomes unconditionally
        // domain-wide (the caller's kind-scoping is silently dropped).
        metadata: {
          domain,
          capability: source.capability ?? null,
          profileSlug: source.profileSlug ?? null,
          label: source.label ?? null,
        },
      }));
      if (feedsLinks.length) await createLinks(feedsLinks);
    } catch (err) {
      logger.warn(
        { err, workspaceId },
        "feeds-link materialization failed (edge declared; placement seam falls back to backfill)"
      );
    }
  }

  return { sourceRoles: mergedRoles, defaultSources: mergedSources };
}
