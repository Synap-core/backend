/**
 * Entities Router - Profile-Based Entity Management
 *
 * Event-driven CRUD with audit trail:
 *   .requested → permission check → inline materialization → .completed
 * Proposal path (AI requiring review) defers to the materializer worker.
 *
 * Supports unfiled entities (workspaceId = null). A NULL-workspace entity is
 * OWNER-private by default (accessScopeWhere floors it to its creator), NOT
 * pod-wide — it becomes visible to a workspace's members only once it carries a
 * facet there (role-as-lens) or an exposure edge.
 *
 * WAVE 3 ROUTER-DECOMPOSITION (2026-08-12): this file is now a thin barrel.
 * The procedures live in co-located `entities/*.ts` modules:
 *   - `entities/helpers.ts`  — leaf: visibility predicates, response codecs,
 *     the facet side-effect emitter, the profile-count aggregator.
 *   - `entities/read.ts`     — countByProfile(All), groupByFacetStatus, list,
 *     listGlobal, listMulti, listSavedUrls, search, getByDocumentId.
 *   - `entities/create.ts`   — create, batchCreate.
 *   - `entities/facets.ts`   — attachFacet, updateFacet, detachFacet.
 *   - `entities/mutate.ts`   — update, delete, moveToWorkspace,
 *     setEntityViewMode, setEntityRenderer.
 *   - `entities/admin.ts`    — adminList, adminGet, adminDelete,
 *     adminBatchDelete, adminListProfiles.
 *
 * `get` stays physically HERE (not split out): it is the identity-wide single-
 * object read whose source-level shape is locked by
 * `__tripwires__/entity-get-identity-wide.test.ts`, and keeping it in the
 * barrel is the simplest way to honor that tripwire without editing its
 * assertions (per the router-decomposition ground rules).
 */

import { z } from "zod";
import { router, podProcedure } from "../trpc.js";
import {
  db,
  eq,
  and,
  isNull,
  getDb,
  ProfileResolutionService,
  getEffectiveFacets,
} from "@synap/database";
import { entities, entityExternalLinks } from "@synap/database/schema";
import { TRPCError } from "@trpc/server";
import { entityReadVisibleWhere, toApiEntity } from "./entities/helpers.js";
import { readProcs } from "./entities/read.js";
import { createProcs } from "./entities/create.js";
import { facetProcs } from "./entities/facets.js";
import { mutateProcs } from "./entities/mutate.js";
import { adminProcs } from "./entities/admin.js";

export {
  mergeSystemData,
  EntityRendererRefSchema,
} from "./entities/helpers.js";

// Key order below is DELIBERATE — it reproduces the original single-file
// declaration order exactly (countByProfile … adminListProfiles) so
// dts-bundle-generator emits the SAME property order into
// api-types/generated.d.ts (object-literal property order is
// insertion-order, and the generator walks it). Grouping the underlying
// procedures into co-located modules is an internal-only reorg; the wire
// contract (including property ORDER, which the gen-types byte-diff check
// is sensitive to) must not move.
export const entitiesRouter = router({
  countByProfile: readProcs.countByProfile,
  countByProfileAll: readProcs.countByProfileAll,
  groupByFacetStatus: readProcs.groupByFacetStatus,
  create: createProcs.create,
  list: readProcs.list,
  listGlobal: readProcs.listGlobal,
  listMulti: readProcs.listMulti,
  listSavedUrls: readProcs.listSavedUrls,
  search: readProcs.search,
  searchAll: readProcs.searchAll,
  getByDocumentId: readProcs.getByDocumentId,

  /**
   * Get entity by ID
   */
  get: podProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        includeProfile: z.boolean().optional().default(false),
        /**
         * @deprecated Kept for wire compatibility only. Single-object reads
         * are identity-wide and never vary by a workspace lens.
         */
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    .output(
      z.object({
        entity: z.any(),
        profile: z.any().optional(),
        effectiveProperties: z.array(z.any()).optional(),
        /** Stable kind-property overlays keyed by every workspace in the user floor. */
        effectivePropertiesByWorkspace: z
          .record(z.string(), z.array(z.any()))
          .optional(),
        /**
         * Every live role the user may see, independent of the active
         * workspace lens. Additive/optional — present only on the
         * `includeProfile` path. Kind + Roles.
         *
         * SHIPPED CONTRACT — the browser host reads `entities.get.facets`
         * (ProfileEntityDetailCell), so the field name is `facets` and must stay
         * `facets`. Per-facet row: the resolver's `{ facet, profile,
         * effectiveProperties }` — `facet` (entity_facets row: id, status,
         * workspaceId, contextEntityId, properties), `profile` (role-profile:
         * slug, displayName, …), `effectiveProperties` (role-scoped property
         * DEFS). The browser host flattens this to its `AttachedFacet` prop.
         */
        facets: z
          .array(
            z.object({
              facet: z.record(z.string(), z.unknown()),
              profile: z.record(z.string(), z.unknown()),
              effectiveProperties: z.array(z.record(z.string(), z.unknown())),
            })
          )
          .optional(),
        /** Tracks where this entity was imported from (empty for user-created entities). */
        externalLinks: z
          .array(
            z.object({
              provider: z.string(),
              externalId: z.string(),
              createdAt: z.string(),
            })
          )
          .optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.id),
          isNull(entities.deletedAt),
          entityReadVisibleWhere(ctx.userId)
        ),
      });

      if (!entity) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
      }

      const typedEntity = toApiEntity(entity);

      // Provenance: always include externalLinks (possibly empty) to keep
      // client types predictable. Single-row entity ⇒ single cheap join.
      const linkRows = await db.query.entityExternalLinks.findMany({
        where: eq(entityExternalLinks.entityId, entity.id),
      });
      const externalLinks = linkRows.map((l) => ({
        provider: l.provider,
        externalId: l.externalId,
        createdAt:
          l.createdAt instanceof Date
            ? l.createdAt.toISOString()
            : new Date(l.createdAt as unknown as string).toISOString(),
      }));

      if (!input.includeProfile) {
        return { entity: typedEntity, externalLinks };
      }

      const database = await getDb();
      const resolutionService = new ProfileResolutionService(database);
      const { validateWorkspaceAccess } =
        await import("../utils/workspace-membership.js");
      // A single-object query has one stable cache identity. Its kind schema is
      // resolved from the object's own scope, never from request/header state.
      const entityWorkspaceId = entity.workspaceId ?? null;
      const [allowedWorkspaceIds, profile] = await Promise.all([
        validateWorkspaceAccess(ctx.userId),
        resolutionService.resolveProfile(
          entity.type,
          ctx.userId,
          entityWorkspaceId
        ),
      ]);
      const stableAllowedWorkspaceIds = [...allowedWorkspaceIds].sort();

      // Keep the identity response lens-free while preserving every accessible
      // kind overlay. All overlay and role resolutions run concurrently; the
      // active Browser surface selects from the stable envelope client-side.
      const [effectiveProperties, workspacePropertyEntries, facets] =
        await Promise.all([
          profile
            ? resolutionService.getEffectiveProperties(
                profile.id,
                entityWorkspaceId
              )
            : Promise.resolve(undefined),
          profile
            ? Promise.all(
                stableAllowedWorkspaceIds.map(
                  async (workspaceId) =>
                    [
                      workspaceId,
                      await resolutionService.getEffectiveProperties(
                        profile.id,
                        workspaceId
                      ),
                    ] as const
                )
              )
            : Promise.resolve([]),
          getEffectiveFacets(database, entity.id, {
            userId: ctx.userId,
            allowedWorkspaceIds: stableAllowedWorkspaceIds,
          }),
        ]);
      const effectivePropertiesByWorkspace = Object.fromEntries(
        workspacePropertyEntries
      );

      return {
        entity: typedEntity,
        ...(profile
          ? { profile, effectiveProperties, effectivePropertiesByWorkspace }
          : {}),
        // Spread into anonymous objects: interfaces lack index signatures, so
        // EntityFacet/Profile aren't assignable to the Record-typed output
        // schema directly. Field name is `facets` — the shipped browser-host
        // contract (see the output schema note).
        facets: facets.map((f) => ({
          facet: { ...f.facet },
          profile: { ...f.profile },
          effectiveProperties: f.effectiveProperties.map((p) => ({ ...p })),
        })),
        externalLinks,
      };
    }),

  update: mutateProcs.update,
  attachFacet: facetProcs.attachFacet,
  updateFacet: facetProcs.updateFacet,
  detachFacet: facetProcs.detachFacet,
  delete: mutateProcs.delete,
  moveToWorkspace: mutateProcs.moveToWorkspace,
  setEntityViewMode: mutateProcs.setEntityViewMode,
  setEntityRenderer: mutateProcs.setEntityRenderer,
  adminList: adminProcs.adminList,
  batchCreate: createProcs.batchCreate,
  adminGet: adminProcs.adminGet,
  adminDelete: adminProcs.adminDelete,
  adminBatchDelete: adminProcs.adminBatchDelete,
  adminListProfiles: adminProcs.adminListProfiles,
});
