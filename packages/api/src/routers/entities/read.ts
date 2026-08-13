/**
 * Entities Router — reads (Wave 3 router-decomposition).
 *
 * `countByProfile(All)`, `groupByFacetStatus`, `list`, `listGlobal`,
 * `listMulti`, `listSavedUrls`, `search`, `getByDocumentId`. `get` itself
 * stays in the `entities.ts` barrel (identity-wide contract tripwire).
 */

import { z } from "zod";
import {
  workspaceProcedure,
  protectedProcedure,
  podProcedure,
} from "../../trpc.js";
import {
  db,
  eq,
  desc,
  and,
  or,
  ilike,
  isNull,
  inArray,
  getDb,
  ProfileResolutionService,
  eventRepository,
  EntityRepository,
  facetRoleExists,
  facetVisibilityConditions,
  profileSlugScopeConditionFromRows,
  drizzleSql,
} from "@synap/database";
import { entities, entityFacets } from "@synap/database/schema";
import { EntitySchema } from "@synap-core/types";
import { TRPCError } from "@trpc/server";
import { assertKnownProfileSlug } from "../../utils/assert-known-profile-slug.js";
import {
  paginatedInput,
  buildPaginatedResponse,
} from "../../utils/pagination.js";
import {
  projectLensWhere,
  facetInWorkspaceLensWhere,
} from "../../utils/project-scope.js";
import { resolveFacetVisibilityScope } from "../../utils/workspace-membership.js";
import {
  entityReadVisibleWhere,
  entityLensWhere,
  toApiEntity,
  toApiEntitiesWithFacets,
  toApiEntitiesWithFacetRows,
  countEntitiesByProfile,
} from "./helpers.js";

export const readProcs = {
  countByProfile: workspaceProcedure
    .output(
      z.object({
        counts: z.record(z.string(), z.number()),
      })
    )
    .query(async ({ ctx }) => {
      const counts = await countEntitiesByProfile({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });
      return { counts };
    }),

  /**
   * Pod-capable sibling of `countByProfile` — same counts, same facet merge,
   * one altitude higher.
   *
   * ALTITUDE: `protectedProcedure` with an OPTIONAL `workspaceId` (mirrors
   * `capabilities.compositions`). The Surfaces "Renderers" tab and every other
   * pod-altitude surface runs with NO active workspace, where the
   * `workspaceProcedure`-built `countByProfile` 400s ("Workspace ID required")
   * — a badge that cannot render at the altitude its app lives at.
   *
   * `workspaceId` NARROWS, it never widens: the owner-private floor is applied
   * FIRST and unconditionally (see `countEntitiesByProfile`), so passing a
   * workspace the caller cannot see yields zero rows rather than a leak. Omit
   * it for the pod floor.
   */
  countByProfileAll: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid().optional() }).optional())
    .output(
      z.object({
        counts: z.record(z.string(), z.number()),
      })
    )
    .query(async ({ ctx, input }) => {
      const counts = await countEntitiesByProfile({
        userId: ctx.userId,
        workspaceId: input?.workspaceId ?? null,
      });
      return { counts };
    }),

  /**
   * Kanban aggregation for a role facet: group the entities wearing role
   * `roleSlug` by their facet `status`, returning per-status `count` + the
   * first `firstN` entity ids (newest first) — the smallest primitive a kanban
   * adapter needs to render columns without pulling every row.
   *
   * A SIBLING of `list` (not a mode on it): `list` is already overloaded
   * (polymorphic profileSlug, facet filter, project/workspace lens, pagination,
   * descendants) and returns a paginated ITEMS shape; a grouped shape would
   * fork its output type conditionally. This keeps `list`'s contract stable.
   *
   * ONE grouped query over `entity_facets ⋈ entities`, under the SAME lens as
   * the entity list: the facet visibility predicate (`facetVisibilityConditions`)
   * AND the entity floor (`entityWriteVisibleWhere`, the userVisibleWhere-based
   * access scope), plus an optional project narrow. A NULL facet status is its
   * own group (the kanban "no status" column).
   */
  groupByFacetStatus: podProcedure
    .input(
      z.object({
        roleSlug: z.string(),
        /** List lens; `undefined` → active workspace, `null` → pod-wide only. */
        workspaceId: z.string().uuid().nullable().optional(),
        /** Optional project narrow (pure narrowing, like `list`). */
        projectId: z.string().uuid().optional(),
        /** Max entity ids returned per status group (0 = counts only). */
        firstN: z.number().int().min(0).max(50).default(10),
      })
    )
    .output(
      z.object({
        roleSlug: z.string(),
        groups: z.array(
          z.object({
            status: z.string().nullable(),
            count: z.number(),
            ids: z.array(z.string()),
          })
        ),
      })
    )
    .query(async ({ input, ctx }) => {
      const lensWorkspaceId =
        input.workspaceId !== undefined ? input.workspaceId : ctx.workspaceId;
      const facetVisibilityScope = await resolveFacetVisibilityScope(
        ctx.userId,
        input.projectId ? undefined : lensWorkspaceId
      );

      // Resolve the role slug to its profile id(s) — every same-slug row (a
      // facet may sit on a system row OR a workspace-scope twin).
      //
      // FAIL CLOSED, same door as `list`/`search`/graph: a kanban mounted on a
      // slug this pod has no profile for (the `crm-lead`-against-a-`lead`-
      // workspace bug, which reproduces here verbatim) must get a typed error,
      // not empty columns indistinguishable from an empty pipeline.
      const roleProfiles = await assertKnownProfileSlug(db, input.roleSlug);
      const roleProfileIds = roleProfiles
        .filter((p) => p.profileKind === "role")
        .map((p) => p.id);
      if (roleProfileIds.length === 0) {
        // Slug EXISTS but names only primary kinds — a kind never carries
        // facets, so this grouping can never return anything. Same class of
        // caller error as an unknown slug; surface it rather than render
        // permanently empty columns.
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            `Profile "${input.roleSlug}" is a kind, not a role. ` +
            `groupByFacetStatus groups entities by their FACET status, so it ` +
            `only applies to role-profiles (profileKind: "role"). List the ` +
            `available roles (profiles.list) and use one of them.`,
        });
      }

      const conditions = [
        inArray(entityFacets.profileId, roleProfileIds),
        isNull(entityFacets.deletedAt),
        ...facetVisibilityConditions(facetVisibilityScope),
        isNull(entities.deletedAt),
        entityReadVisibleWhere(ctx.userId),
        ...(input.projectId
          ? [projectLensWhere(entities.id, input.projectId)]
          : []),
      ];

      // firstN is a zod-validated int (0..50) → safe to inline as an array-slice
      // literal (avoids a parameterised slice bound). array_agg newest-first,
      // sliced to firstN; 0 yields an empty slice (counts only).
      const rows = await db
        .select({
          status: entityFacets.status,
          count: drizzleSql<number>`cast(count(*) as integer)`,
          ids: drizzleSql<
            string[]
          >`(array_agg(${entities.id} ORDER BY ${entities.createdAt} DESC))[1:${drizzleSql.raw(String(input.firstN))}]`,
        })
        .from(entityFacets)
        .innerJoin(entities, eq(entities.id, entityFacets.entityId))
        .where(and(...conditions))
        .groupBy(entityFacets.status);

      return {
        roleSlug: input.roleSlug,
        groups: rows.map((r) => ({
          status: r.status ?? null,
          count: r.count,
          ids: r.ids ?? [],
        })),
      };
    }),
  list: podProcedure
    .input(
      paginatedInput.extend({
        profileSlug: z.string().optional(),
        /** When true and profileSlug is set, also return entities of child profiles.
         *  e.g. profileSlug='person' + includeDescendants=true → returns person + contact + any custom children. */
        includeDescendants: z.boolean().optional().default(false),
        /** When true, only return global entities */
        globalOnly: z.boolean().optional().default(false),
        /**
         * PRODUCT DECISION (scoped default, 2026-06-15): when a workspace is
         * active, the list returns ONLY that workspace's entities — pod-wide
         * (workspaceId IS NULL) rows are NOT mixed in, so a focused workspace
         * lens no longer bleeds pod-wide notes/captures. Defaults to `false`;
         * an EXPLICITLY pod-scoped/global view (the CRM's pod-wide person/company
         * reads, the user-floor Hub endpoints) passes `includePodWide: true` to
         * restore the union (this workspace's rows OR pod-wide globals). No data
         * is migrated. Ignored for `globalOnly` and workspace-less callers (those
         * already return pod-wide-only / the full user floor).
         */
        includePodWide: z.boolean().optional().default(false),
        /**
         * Explicit list lens. `undefined` falls back to ctx.workspaceId for
         * backwards compatibility; `null` returns the caller's pod-wide rows.
         */
        workspaceId: z.string().uuid().nullable().optional(),
        /**
         * Project LENS (project-centric-scope) — narrow to one project's data.
         * In the INPUT (not a header) so it lands in the React Query key and the
         * cache separates per project. A lens only narrows: access is enforced by
         * the floor (`entityWriteVisibleWhere`, which already grants project members);
         * a forged id can never widen.
         */
        projectId: z.string().uuid().optional(),
        /** Filter to entities materialized from a specific proposal (provenance). */
        sourceProposalId: z.string().uuid().optional(),
        /**
         * Facet filter (Kind + Facets): only return entities carrying a live
         * facet of this role-profile. Resolved to `facetProfileId` via slug
         * lookup when only the slug is given; `facetProfileId` wins if both
         * are provided.
         */
        facetSlug: z.string().optional(),
        facetProfileId: z.string().uuid().optional(),
        /**
         * Kind + Facets, opt-in rich annotation. Default `false` keeps the
         * response byte-identical to today's: `facetSlugs` only. Set `true` to
         * ALSO get `facets` — each live facet's overlay `properties`/`status`
         * beside its slug — for a list page that must read a facet property
         * (e.g. the CRM's `leadStage: "prospect"`, invisible in a slug alone).
         * Costs the same ONE batched query under the SAME visibility lens; it
         * only widens the projection, so it is never an N+1.
         */
        includeFacets: z.boolean().optional().default(false),
      })
    )
    .query(async ({ input, ctx }) => {
      // Scoped-by-default: with an active workspace and includePodWide=false,
      // return ONLY that workspace's rows. includePodWide=true restores the
      // legacy "workspace OR pod-wide globals" union. globalOnly / workspace-less
      // callers are unaffected (they already resolve to pod-wide-only below).
      //
      // Role-as-lens (Phase 2): when filtering by facetSlug/facetProfileId,
      // masters are often pod-wide (entityScope pod) with a role hat. Default
      // includePodWide=true so "list leads in CRM" returns pod-wide persons
      // wearing `lead`, not an empty page. Explicit includePodWide:false still
      // wins for callers that want workspace-only rows.
      const includePodWideEffective =
        input.includePodWide === true ||
        (input.includePodWide !== false &&
          Boolean(input.facetSlug || input.facetProfileId));
      const lensWorkspaceId =
        input.workspaceId !== undefined ? input.workspaceId : ctx.workspaceId;
      const facetVisibilityScope = await resolveFacetVisibilityScope(
        ctx.userId,
        input.projectId ? undefined : lensWorkspaceId
      );
      // The scope rule (unified, floor-first):
      //   • PROJECT lens → the full user floor (incl. the project-membership
      //     branch, so a member sees the project ACROSS workspaces); the
      //     `projectLensWhere` narrow below restricts to that project.
      //   • EXPLICIT globals-only (`globalOnly`, or an explicit `workspaceId:
      //     null`) → pod-wide globals only.
      //   • a SPECIFIC workspace (input or the active-ws header) → that workspace.
      //   • NO lens at all (no input workspaceId AND no header) → the USER FLOOR
      //     (all the user's workspaces + globals), NOT globals-only. This is the
      //     "no lens = everything you can access" rule and makes `.list` with no
      //     lens a strict superset of (and the replacement for) `.listAll`.
      let workspaceScopeCondition;
      if (input.projectId) {
        workspaceScopeCondition = entityReadVisibleWhere(ctx.userId);
      } else if (input.globalOnly || input.workspaceId === null) {
        workspaceScopeCondition = entityLensWhere(ctx.userId, null);
      } else if (lensWorkspaceId) {
        workspaceScopeCondition = entityLensWhere(ctx.userId, lensWorkspaceId, {
          includePodWide: includePodWideEffective,
        });
      } else {
        workspaceScopeCondition = entityReadVisibleWhere(ctx.userId);
      }
      // Visibility is enforced at QUERY level — `list` is a `podProcedure`, so there
      // is NO procedure-level workspace gate. `workspaceScopeCondition` delegates to
      // `entityLensWhere`/`entityWriteVisibleWhere`, which restrict rows to the user floor
      // (workspace membership + pod-personal + project membership). `userId` is a
      // security predicate there, not mere attribution.
      const conditions: any[] = [isNull(entities.deletedAt)];

      if (input.sourceProposalId) {
        conditions.push(eq(entities.sourceProposalId, input.sourceProposalId));
      }

      if (input.profileSlug) {
        const database = await getDb();

        // Kind + Facets: a profileSlug can now name either a primary `kind`
        // (entities carry it as their `type`/profileId) or an attachable
        // `role` (entities carry it as a live facet). `convertToFacet` flips
        // profile_kind in place — same slug — so a slug that filtered by
        // `entities.type` before conversion must resolve to the SAME entities
        // via the facet-EXISTS after. Resolve ALL rows for the slug (a slug
        // can be carried by a system row AND a workspace-scope twin — the
        // legacy text match was row-blind, so the role routing must OR every
        // role row's id or entities faceted on the twin vanish).
        //
        // Resolved through the ONE slug lookup (`profileSlugRows`) the scope
        // predicate uses, then asserted non-empty: a slug naming no profile at
        // all would otherwise fall through to the row-blind `entities.type`
        // match, return `[]`, and be indistinguishable from a genuinely empty
        // list (the `crm-lead`-against-a-`lead`-workspace bug).
        const slugProfiles = await assertKnownProfileSlug(
          database,
          input.profileSlug
        );
        const roleProfileIds = slugProfiles
          .filter((p) => p.profileKind === "role")
          .map((p) => p.id);
        // The old `slugProfiles.length === 0 ||` disjunct is gone: the assert
        // above guarantees at least one row, so the zero-row fallback here is
        // unreachable. A slug carrying ONLY role rows now correctly yields no
        // kind branch instead of an `entities.type` match that never hits.
        const hasKindRow = slugProfiles.some((p) => p.profileKind !== "role");

        const slugBranches: any[] = [];
        if (roleProfileIds.length > 0) {
          // Role rows: match entities carrying a live facet, via the same
          // one-door EXISTS the `facetSlug` filter uses.
          slugBranches.push(
            facetRoleExists(database, roleProfileIds, facetVisibilityScope)
          );
        }
        if (hasKindRow) {
          // Kind rows (default / unconverted): match by primary type, with
          // optional descendant expansion over the kind hierarchy.
          const profileService = new ProfileResolutionService(database);
          let profileSlugs = [input.profileSlug];
          if (input.includeDescendants) {
            const descendants = await profileService.getDescendantSlugs(
              input.profileSlug,
              ctx.workspaceId ?? undefined
            );
            profileSlugs = [input.profileSlug, ...descendants];
          }

          // Use inArray for multiple slugs, eq for single (simpler query plan)
          if (profileSlugs.length === 1) {
            slugBranches.push(eq(entities.type, profileSlugs[0]));
          } else {
            slugBranches.push(inArray(entities.type, profileSlugs));
          }
        }
        conditions.push(
          slugBranches.length === 1 ? slugBranches[0] : or(...slugBranches)
        );

        // Pod-default and workspace-scoped profiles share the same read filter
        // (workspaceScopeCondition, computed above): workspace-only by default,
        // or workspace OR pod-wide globals when includePodWide is set.
        conditions.push(workspaceScopeCondition);
      } else {
        // No profile filter — same workspace scoping.
        conditions.push(workspaceScopeCondition);
      }

      // Project lens (project-centric-scope): narrow to the selected project's
      // data on top of the workspace scope. ANDed with the floor above, so it
      // can only narrow — never widen. Omitted when no project is selected.
      if (input.projectId) {
        conditions.push(projectLensWhere(entities.id, input.projectId));
      }

      // Facet filter (Kind + Facets): narrow to entities carrying a live
      // facet of the given role-profile, visible under the same lens as the
      // entity list itself.
      if (input.facetSlug || input.facetProfileId) {
        // Same multi-row rule as the profileSlug branch above: one slug can
        // be carried by several profile rows (system + workspace twins), and
        // a facet may sit on ANY of them — match every row's id, never a
        // findFirst pick.
        //
        // FAIL CLOSED on an unknown `facetSlug` — same door as the
        // `profileSlug` branch above. This used to push `false` and return an
        // empty page, which is exactly the silent-empty this workstream
        // exists to kill: "this pod has no such role" read as "no rows".
        const facetProfileIds = input.facetProfileId
          ? [input.facetProfileId]
          : (await assertKnownProfileSlug(db, input.facetSlug!)).map(
              (p) => p.id
            );
        conditions.push(
          facetRoleExists(db, facetProfileIds, facetVisibilityScope)
        );
      }

      const results = await db.query.entities.findMany({
        where: and(...conditions),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit + 1,
        offset: input.offset,
      });

      const totalRow = await db
        .select({ count: drizzleSql<number>`count(*)::int` })
        .from(entities)
        .where(and(...conditions));
      const total = totalRow[0]?.count ?? 0;

      // Kind + Facets annotation. The opt-in branch loads the rich rows (slug +
      // overlay) instead of slugs-only — same single batched query, same lens.
      // Unset/false takes the untouched default path.
      const annotated = input.includeFacets
        ? await toApiEntitiesWithFacetRows(results, facetVisibilityScope)
        : await toApiEntitiesWithFacets(results, facetVisibilityScope);

      const { items, pagination } = buildPaginatedResponse(
        annotated,
        input,
        total
      );

      return {
        items,
        pagination,
        total,
        /** @deprecated Use `items` instead */
        entities: items,
        /** @deprecated Use `pagination.hasMore` instead */
        hasMore: pagination.hasMore,
      };
    }),

  /**
   * List global entities (no workspace required)
   *
   * Returns only entities where workspaceId IS NULL.
   * Uses protectedProcedure — works even without an active workspace.
   */
  listGlobal: protectedProcedure
    .input(
      z.object({
        profileSlug: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .output(
      z.object({
        entities: z.array(EntitySchema),
      })
    )
    .query(async ({ input, ctx }) => {
      const conditions: any[] = [
        eq(entities.userId, ctx.userId),
        isNull(entities.workspaceId),
      ];

      if (input.profileSlug) {
        // Polymorphic (Kind + Facets); pod-personal list → pod-wide facet
        // lens (workspaceId: null) + owner floor. Fail closed first on a slug
        // that names no profile at all — otherwise the predicate's row-blind
        // kind branch returns `[]` and "no such vocabulary" reads as "empty".
        const database = await getDb();
        const slugRows = await assertKnownProfileSlug(
          database,
          input.profileSlug
        );
        conditions.push(
          profileSlugScopeConditionFromRows(
            database,
            input.profileSlug,
            slugRows,
            { userId: ctx.userId, workspaceId: null }
          )
        );
      }

      const results = await db.query.entities.findMany({
        where: and(...conditions),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit,
      });

      return {
        entities: await toApiEntitiesWithFacets(results, {
          userId: ctx.userId,
          workspaceId: null,
        }),
      };
    }),

  /**
   * List entities across multiple workspaces the user has access to.
   *
   * Unlike `list` (which is workspace-scoped via header), this endpoint
   * accepts an explicit `workspaceIds` array and is callable without an
   * active workspace header. Useful for cross-workspace dashboards and
   * global search aggregation.
   *
   * Security: `workspaceIds` is silently filtered to workspaces the caller
   * is actually a member of — unknown or inaccessible IDs are ignored.
   * Omitting `workspaceIds` returns entities from ALL user's workspaces.
   */
  listMulti: protectedProcedure
    .input(
      z.object({
        workspaceIds: z.array(z.string().uuid()).optional(),
        profileSlug: z.string().optional(),
        includeGlobal: z.boolean().default(false),
        limit: z.number().min(1).max(200).default(50),
      })
    )
    .output(
      z.object({
        entities: z.array(EntitySchema),
      })
    )
    .query(async ({ input, ctx }) => {
      const { validateWorkspaceAccess } =
        await import("../../utils/workspace-membership.js");

      const validatedIds = await validateWorkspaceAccess(
        ctx.userId,
        input.workspaceIds
      );

      const db2 = await getDb();
      // Must be the shared singleton, not `new EventRepository(sql)` — a fresh
      // instance has no registered hooks, so emitCompleted()'s append silently
      // never reaches the realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const entityRepo = new EntityRepository(db2, eventRepo);

      const results = await entityRepo.listForWorkspaces(
        validatedIds,
        ctx.userId,
        {
          profileSlug: input.profileSlug,
          limit: input.limit,
          includeGlobal: input.includeGlobal,
        }
      );

      return {
        entities: await toApiEntitiesWithFacets(results, {
          userId: ctx.userId,
          allowedWorkspaceIds: validatedIds,
        }),
      };
    }),

  /**
   * List all entities in this workspace that have a URL property.
   * Used by the browser's URL index to know which pages have been saved,
   * powering the bookmark ⭐ state and duplicate detection.
   * Returns a slim payload — no full property values, just what the index needs.
   */
  listSavedUrls: podProcedure
    .input(
      z
        .object({
          workspaceId: z.string().uuid().optional(),
        })
        .optional()
    )
    .output(
      z.array(
        z.object({
          id: z.string(),
          url: z.string(),
          title: z.string(),
          profileSlug: z.string(),
          createdAt: z.string(),
        })
      )
    )
    .query(async ({ input, ctx }) => {
      const lensWorkspaceId = input?.workspaceId ?? ctx.workspaceId ?? null;
      const workspaceFilter = lensWorkspaceId
        ? entityLensWhere(ctx.userId, lensWorkspaceId, { includePodWide: true })
        : entityReadVisibleWhere(ctx.userId);
      const rows = await db
        .select({
          id: entities.id,
          title: entities.title,
          type: entities.type,
          createdAt: entities.createdAt,
          url: drizzleSql<string>`${entities.properties}->>'url'`,
        })
        .from(entities)
        .where(
          and(
            workspaceFilter,
            drizzleSql`${entities.properties}->>'url' IS NOT NULL`,
            drizzleSql`${entities.properties}->>'url' != ''`
          )
        )
        .orderBy(desc(entities.createdAt));

      return rows.map((r) => ({
        id: r.id,
        url: r.url,
        title: r.title ?? r.url,
        profileSlug: r.type ?? "bookmark",
        createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
      }));
    }),

  /**
   * Search entities (vector + text)
   */
  search: workspaceProcedure
    .input(
      z.object({
        query: z.string(),
        profileSlug: z.string().optional(),
        limit: z.number().min(1).max(50).default(10),
      })
    )
    .output(
      z.object({
        entities: z.array(EntitySchema),
      })
    )
    .query(async ({ input, ctx }) => {
      const facetVisibilityScope = await resolveFacetVisibilityScope(
        ctx.userId,
        ctx.workspaceId
      );
      // Floor: every search result must belong to the caller. This prevents
      // pod-personal entities (workspaceId IS NULL) that belong to OTHER users
      // from leaking through — both the pod-scoped-profile branch (which
      // previously skipped the workspace filter) and the workspace branch
      // (which had no per-user guard on the NULL case).
      const conditions: any[] = [entityReadVisibleWhere(ctx.userId)];

      // The advertised contract: input.query MATCHES. (This was silently
      // ignored for months — every caller got recent entities regardless of
      // text.) Lexical title match here; richer ranking belongs to the
      // Typesense/SRE doors.
      const trimmedQuery = input.query.trim();
      if (trimmedQuery.length > 0) {
        conditions.push(ilike(entities.title, `%${trimmedQuery}%`));
      }

      // Workspace narrow for search: the active workspace + pod-wide globals,
      // PLUS entities role-attached to the active workspace (facet-aware — mirrors
      // entities.list's lens, so search and list agree). It is ANDed with the
      // floor above, so it can only surface a row the floor already admits; a
      // forged workspace can't widen. Globals-only when there is no active
      // workspace (facet branch needs a concrete workspace to key on).
      const searchWorkspaceNarrow = ctx.workspaceId
        ? or(
            eq(entities.workspaceId, ctx.workspaceId),
            isNull(entities.workspaceId),
            facetInWorkspaceLensWhere(entities.id, ctx.userId, ctx.workspaceId)
          )!
        : or(
            eq(entities.workspaceId, ctx.workspaceId),
            isNull(entities.workspaceId)
          )!;

      if (input.profileSlug) {
        // Polymorphic (Kind + Facets): a role slug matches via the facet
        // EXISTS, a kind slug via entities.type — same routing as
        // entities.list, through the shared one-door helper. Fail closed on an
        // unknown slug before building the predicate (see assertKnownProfileSlug).
        const database = await getDb();
        const slugRows = await assertKnownProfileSlug(
          database,
          input.profileSlug
        );
        conditions.push(
          profileSlugScopeConditionFromRows(
            database,
            input.profileSlug,
            slugRows,
            facetVisibilityScope
          )
        );

        // For workspace-scoped profiles, also narrow to the active workspace
        // (plus pod-wide globals already covered by the floor above).
        const profileService = new ProfileResolutionService(database);
        const entityScope = await profileService.getEntityScope(
          input.profileSlug,
          ctx.workspaceId
        );

        if (entityScope !== "pod") {
          conditions.push(searchWorkspaceNarrow);
        }
      } else {
        conditions.push(searchWorkspaceNarrow);
      }

      const results = await db.query.entities.findMany({
        where: and(...conditions),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit,
      });

      return {
        entities: await toApiEntitiesWithFacets(results, facetVisibilityScope),
      };
    }),

  /**
   * Get entity by document ID (reverse lookup)
   */
  getByDocumentId: podProcedure
    .input(z.object({ documentId: z.string().uuid() }))
    .output(z.object({ entity: z.any().nullable() }))
    .query(async ({ input, ctx }) => {
      // Single-object read: visibility from the user floor alone, never the
      // ambient lens. Uses the same predicate as entities.get so a cross-
      // workspace lookup (entity in a workspace the user belongs to, just not
      // the active one) resolves instead of returning null.
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.documentId, input.documentId),
          isNull(entities.deletedAt),
          entityReadVisibleWhere(ctx.userId)
        ),
      });

      if (!entity) return { entity: null };

      return { entity: toApiEntity(entity) };
    }),
};
