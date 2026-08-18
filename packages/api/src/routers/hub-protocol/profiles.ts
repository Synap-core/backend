/**
 * Hub Protocol - Profiles & Property Defs Router
 *
 * Exposes entity schema management to Intelligence Hub agents.
 * Profiles define entity types; property defs define custom fields.
 *
 * Governance:
 *   - META-MODEL writes PROPOSE by default. `profile.create`, `profile.update`,
 *     `property_def.create` and `property_def.update` are DELIBERATELY ABSENT
 *     from DEFAULT_AUTO_APPROVE (containment-asymmetry pass): a kind/role row is
 *     pod-wide (`entityScope` defaults to 'pod') and a base property def
 *     (workspace_id NULL) extends a shared kind for every workspace at once, and
 *     — unlike `automation.create`, which auto-approves BUT lands INERT as a
 *     draft — these tables have NO inert state to land in. So an agent caller
 *     gets `status: 'proposed'`; operators apply directly.
 *   - `view.create` REMAINS auto-approved (presentational, per-workspace,
 *     reversible, high volume).
 *   - Widening is user-editable without a code change: a `governance_rules` row
 *     at action granularity (rung 2.8) can restore `auto` for a trusted agent.
 *   - Every write is gated through `checkPermissionOrPropose`, so a workspace
 *     that opts into stricter review is honored rather than silently bypassed.
 *   - No delete endpoints exposed to agents.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { RendererRef } from "@synap/database";
import { and, db, eq, isNull, or, widgetDefinitions } from "@synap/database";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { profilesRouter as regularProfilesRouter } from "../profiles.js";
import { propertyDefsRouter as regularPropertyDefsRouter } from "../property-defs.js";
import { createHubProtocolCallerContext } from "./utils.js";
import { assertMayActAs } from "./guard.js";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { setProfileRenderer } from "../../services/profiles/set-profile-renderer.js";
import { createAndLinkPropertyDef } from "../../services/profiles/create-and-link-property-def.js";

/**
 * Frame definitions are registered directly. Iframe widgets resolve through the
 * generic (sandboxed) iframe host.
 *
 * `"native"` is kept in the branch below deliberately, and NOT because native is
 * sandboxed — it never was. The renderer has been removed, but legacy rows still
 * carry `renderer_type = 'native'`. Mapping them to the sandboxed iframe host is
 * the fail-SAFE degradation: such a row has no `rendererSource`, so it renders an
 * init error instead of executing anything. Do not "fix" this by routing native
 * anywhere that runs code. See NATIVE_RENDERER_REJECTED in
 * `routers/widget-definitions.ts`.
 */
export function buildCellRendererRef(
  cellKey: string,
  props?: Record<string, unknown>,
  rendererType?: string | null
): RendererRef {
  if (rendererType === "iframe" || rendererType === "native") {
    return {
      kind: "cell",
      cellKey: "iframe-widget",
      props: { typeKey: cellKey, ...(props ?? {}) },
    };
  }
  return { kind: "cell", cellKey, props: props ?? {} };
}

const ProfileRendererContentKindSchema = z.enum([
  "entity-detail",
  "entity-card",
  "entity-profile",
  "collection",
]);

export const hubProfilesRouter = router({
  /**
   * List profiles accessible in a workspace
   * Requires: hub-protocol.read scope
   */
  listProfiles: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        /** Omit for the caller's pod/base profile floor (no workspace overlay lens). */
        workspaceId: z.string().uuid().nullable().optional(),
        /** Narrow an already-oriented read to these profile slugs. */
        profileSlugs: z.array(z.string().min(1).max(100)).max(50).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      // The REST door accepts `userId` for legacy clients, but reads must stay
      // on the authenticated API-key owner. Reusing a body/query user id here
      // would let a caller reconstruct another user's caller context.
      const userId = ctx.userId;
      if (!userId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      const callerContext = await createHubProtocolCallerContext(
        userId,
        ctx.scopes || [],
        input.workspaceId ?? null
      );
      const caller = regularProfilesRouter.createCaller(callerContext);
      return caller.list(
        input.profileSlugs ? { profileSlugs: input.profileSlugs } : undefined
      );
    }),

  /**
   * Read one profile and its effective property schema through an explicit
   * workspace lens. No workspace means base definitions only; it is never
   * replaced with a default workspace.
   */
  getProfile: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().nullable().optional(),
        identifier: z.string().min(1).max(100),
      })
    )
    .query(async ({ input, ctx }) => {
      const userId = ctx.userId;
      if (!userId) throw new TRPCError({ code: "UNAUTHORIZED" });
      const callerContext = await createHubProtocolCallerContext(
        userId,
        ctx.scopes || [],
        input.workspaceId ?? null
      );
      const caller = regularProfilesRouter.createCaller(callerContext);
      return caller.get({ identifier: input.identifier });
    }),

  /**
   * Create a profile (entity type definition)
   * Requires: hub-protocol.write scope
   * Governance: PROPOSES for agent callers — `profile.create` is deliberately
   * NOT in DEFAULT_AUTO_APPROVE (a kind/role is pod-wide structure with no
   * inert state to land in). The `profile/create` proposal executor
   * materializes an approved proposal through the same path used here.
   */
  createProfile: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
        slug: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9-]+$/),
        displayName: z.string().min(1).max(200),
        description: z.string().optional(),
        defaultValues: z.record(z.string(), z.unknown()).optional(),
        parentProfileId: z.string().uuid().optional(),
        uiHints: z.record(z.string(), z.unknown()).optional(),
        reasoning: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
        /** Kind vs role profile. Omit → 'kind'. 'role' mints a facet type. */
        profileKind: z.enum(["kind", "role"]).optional(),
        /** For profileKind='role': base-kind slugs this role can attach to. */
        applicableKinds: z.array(z.string()).optional(),
        /** Role-category grouping key (0222): clusters role-profiles so
         *  `entity.query { roleCategory }` matches every role in the category. */
        roleCategory: z.string().optional(),
        /**
         * Where entities of this type live. OMIT to let the one door
         * (`resolveEntityScope`, profile-repository.ts) decide: a kind with no
         * declared scope lands 'pod' (kinds are pod-wide), a role lands
         * 'workspace'. Declare 'workspace' explicitly only for an app-specific
         * kind. 'pod' on a role is rejected by that resolver.
         */
        entityScope: z.enum(["pod", "workspace"]).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      assertMayActAs(ctx, input.userId);
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        input.workspaceId,
        ctx.sourceMessageId ?? undefined
      );
      const caller = regularProfilesRouter.createCaller(callerContext);

      return caller.create({
        slug: input.slug,
        displayName: input.displayName,
        defaultValues: input.defaultValues,
        parentProfileId: input.parentProfileId,
        uiHints: input.uiHints,
        reasoning: input.reasoning,
        scope: "workspace",
        source: "intelligence",
        agentUserId: input.agentUserId,
        ...(input.profileKind ? { profileKind: input.profileKind } : {}),
        ...(input.applicableKinds
          ? { applicableKinds: input.applicableKinds }
          : {}),
        ...(input.roleCategory != null
          ? { roleCategory: input.roleCategory }
          : {}),
        // Passed through ONLY when declared — an omitted entityScope must reach
        // `resolveEntityScope` as undefined so the kind→pod / role→workspace
        // doctrine default applies instead of a value invented here.
        ...(input.entityScope ? { entityScope: input.entityScope } : {}),
      });
    }),

  /**
   * List property definitions for a workspace (optionally filtered by profileId)
   * Requires: hub-protocol.read scope
   */
  listPropertyDefs: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
        profileId: z.string().uuid().optional(),
        /** Target several already-resolved profiles without loading all schemas. */
        profileIds: z.array(z.string().uuid()).max(50).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      // See listProfiles: `input.userId` is legacy transport data, never the
      // authorization identity for a read.
      const userId = ctx.userId;
      if (!userId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      const callerContext = await createHubProtocolCallerContext(
        userId,
        ctx.scopes || [],
        input.workspaceId
      );
      const caller = regularPropertyDefsRouter.createCaller(callerContext);
      const profileIds =
        input.profileIds ?? (input.profileId ? [input.profileId] : undefined);
      const result = await caller.list(profileIds ? { profileIds } : undefined);
      // Preserve the legacy single-profile response shape for existing callers.
      if (input.profileId && !input.profileIds) {
        return {
          propertyDefs: result.propertyDefs.filter(
            (d: any) => d.profileId === input.profileId
          ),
        };
      }
      return result;
    }),

  /**
   * Get the effective renderer for a profile in a workspace, by content kind.
   * External agents (Eve, IS) use this to discover how to surface an
   * entity profile without going through tRPC. Requires hub-protocol.read.
   *
   * Returns all content kinds when omitted. Resolution mirrors the regular
   * tRPC procedure (workspace overlay → profile default → hardcoded fallback).
   */
  getEffectiveRenderers: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
        profileSlug: z.string(),
        contentKind: ProfileRendererContentKindSchema.optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const userId = ctx.userId;
      if (!userId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      const callerContext = await createHubProtocolCallerContext(
        userId,
        ctx.scopes || [],
        input.workspaceId
      );
      const caller = regularProfilesRouter.createCaller(callerContext);
      return caller.getEffectiveRenderers({
        profileSlug: input.profileSlug,
        contentKind: input.contentKind,
      });
    }),

  /**
   * Bind a cell as a profile's renderer (list | detail | dashboard).
   * Requires: hub-protocol.write scope.
   *
   * GOVERNANCE (locked): binding an AI-generated cell as a durable renderer is
   * consequential, so this routes through `checkPermissionOrPropose` with the
   * `profile` / `renderer.set` action — which is DELIBERATELY absent from
   * DEFAULT_AUTO_APPROVE, as every `profile` / `property_def` meta-model write
   * now is (containment-asymmetry pass). Agent callers therefore get
   * `status: 'proposed'` (awaiting review); operators get `status: 'applied'`.
   * The `profile/renderer.set` proposal executor materializes an approved
   * proposal via the SAME `setProfileRenderer` service used here.
   *
   * scope 'workspace' (default) writes the per-workspace overlay; scope 'pod'
   * writes the profile's system default (visible in every workspace).
   */
  setRenderer: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().optional(),
        profileSlug: z.string().min(1),
        slot: z.enum(["list", "detail", "dashboard"]),
        cellKey: z.string().min(1),
        props: z.record(z.string(), z.unknown()).optional(),
        scope: z.enum(["workspace", "pod"]).optional(),
        agentUserId: z.string().uuid().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Identity floor: `input.userId` is the acting identity fed to
      // checkPermissionOrPropose and the setProfileRenderer write — a hub PAT may
      // act only as its own owner.
      assertMayActAs(ctx, input.userId);
      const scope = input.scope ?? "workspace";
      const workspaceId = input.workspaceId ?? null;
      const definition = await db.query.widgetDefinitions.findFirst({
        where: and(
          eq(widgetDefinitions.typeKey, input.cellKey),
          workspaceId
            ? or(
                eq(widgetDefinitions.workspaceId, workspaceId),
                isNull(widgetDefinitions.workspaceId)
              )
            : isNull(widgetDefinitions.workspaceId)
        ),
        columns: { rendererType: true },
      });
      const ref: RendererRef = buildCellRendererRef(
        input.cellKey,
        input.props,
        definition?.rendererType
      );

      const perm = await checkPermissionOrPropose({
        userId: input.userId,
        agentUserId: input.agentUserId,
        workspaceId,
        subjectType: "profile",
        action: "renderer.set",
        source: "intelligence",
        reasoning: input.reasoning,
        data: {
          profileSlug: input.profileSlug,
          slot: input.slot,
          scope,
          ref,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new Error(perm.reason);
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
        };
      }

      // Granted (operator) → apply immediately via the shared write path.
      await setProfileRenderer({
        userId: input.userId,
        workspaceId,
        profileSlug: input.profileSlug,
        slot: input.slot,
        ref,
        scope,
      });
      return { status: "applied" as const, proposalId: null };
    }),

  /**
   * Create a property definition for a profile, and link it into
   * `profile_properties` so it actually renders (a property def is invisible
   * to a profile until linked — see `createAndLinkPropertyDef`).
   *
   * Requires: hub-protocol.write scope
   *
   * GOVERNANCE: routed through `checkPermissionOrPropose` with
   * `subjectType: 'property_def'`, `action: 'create'` — mirrors the
   * `entity/create` gate exactly. `property_def.create` is deliberately NOT in
   * DEFAULT_AUTO_APPROVE (a base property def carries workspace_id NULL and so
   * extends a shared kind for EVERY workspace at once, with no inert state to
   * land in), so an agent caller gets `status: 'proposed'`; operators apply
   * directly. On approval, the `property_def/create` proposal executor
   * materializes via the SAME `createAndLinkPropertyDef` helper used here.
   *
   * Phase 2 layered schemas: pass `overlay: true` with a `workspaceId` to
   * create a workspace-scoped overlay field (invisible to other workspaces).
   * Default behaviour creates a "base" def visible to every workspace that
   * uses the profile. Agents adding a custom field to a shared profile
   * (Person, Task, …) should prefer overlays to avoid cross-workspace leaks.
   */
  createPropertyDef: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
        profileId: z.string().uuid().optional(),
        slug: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9-]+$/),
        /** Value type: text, number, boolean, date, select, multi_select, relation, url, email */
        valueType: z.string().min(1),
        constraints: z.record(z.string(), z.unknown()).optional(),
        uiHints: z.record(z.string(), z.unknown()).optional(),
        agentUserId: z.string().uuid().optional(),
        reasoning: z.string().optional(),
        /**
         * When true, create a workspace-scoped overlay (invisible to other
         * workspaces). Default false = base def.
         */
        overlay: z.boolean().optional(),
        /** profile_properties link options. */
        required: z.boolean().optional(),
        defaultValue: z.unknown().optional(),
        displayOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Identity floor: `input.userId` is the acting identity fed to
      // checkPermissionOrPropose and the createAndLinkPropertyDef write
      // (auto-approved → a live schema write into the target workspace) — a hub
      // PAT may act only as its own owner.
      assertMayActAs(ctx, input.userId);
      const overlay = input.overlay === true;
      const valueType = input.valueType as
        | "string"
        | "number"
        | "boolean"
        | "object"
        | "array"
        | "date"
        | "secret"
        | "entity_id";

      const perm = await checkPermissionOrPropose({
        userId: input.userId,
        agentUserId: input.agentUserId,
        workspaceId: input.workspaceId,
        subjectType: "property_def",
        action: "create",
        source: "intelligence",
        reasoning: input.reasoning,
        data: {
          profileId: input.profileId,
          slug: input.slug,
          valueType,
          constraints: input.constraints,
          uiHints: input.uiHints,
          overlay,
          workspaceId: input.workspaceId,
          required: input.required,
          defaultValue: input.defaultValue,
          displayOrder: input.displayOrder,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new Error(perm.reason);
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
        };
      }

      // Granted (operator, or agent within DEFAULT_AUTO_APPROVE) → apply
      // immediately via the shared create+link path.
      const { propertyDef, link } = await createAndLinkPropertyDef({
        userId: input.userId,
        workspaceId: input.workspaceId,
        profileId: input.profileId,
        slug: input.slug,
        valueType,
        constraints: input.constraints,
        uiHints: input.uiHints,
        overlay,
        required: input.required,
        defaultValue: input.defaultValue,
        displayOrder: input.displayOrder,
      });

      return {
        status: "applied" as const,
        proposalId: null,
        propertyDef,
        link,
      };
    }),
});
