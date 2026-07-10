/**
 * Hub Protocol - Profiles & Property Defs Router
 *
 * Exposes entity schema management to Intelligence Hub agents.
 * Profiles define entity types; property defs define custom fields.
 *
 * Governance:
 *   - Profile create/update ops are routed through DEFAULT_AUTO_APPROVE
 *     (view.create, profile.create, profile.update, property_def.create, property_def.update
 *     are in the whitelist — schema evolution is non-destructive and reversible),
 *     but every write is still gated through `checkPermissionOrPropose` so a
 *     workspace that opts into stricter review (SAFE mode / a narrowed
 *     `autoApproveFor`) is honored instead of silently bypassed.
 *   - No delete endpoints exposed to agents.
 */

import { z } from "zod";
import type { RendererRef } from "@synap/database";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { profilesRouter as regularProfilesRouter } from "../profiles.js";
import { propertyDefsRouter as regularPropertyDefsRouter } from "../property-defs.js";
import { createHubProtocolCallerContext } from "./utils.js";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { setProfileRenderer } from "../../services/profiles/set-profile-renderer.js";
import { createAndLinkPropertyDef } from "../../services/profiles/create-and-link-property-def.js";
import { getDb, eq } from "@synap/database";
import { widgetDefinitions } from "@synap/database/schema";

/**
 * Build a RendererRef from a cellKey — mirrors the browser's buildCellRendererRef
 * so both surfaces produce a renderable ref. A generated/published cell (a
 * widget_definition, e.g. `generated:*`) is NOT a registered cellRegistry key; it
 * renders only through the `iframe-widget` host by its typeKey. So when the cellKey
 * names a widget_definition, wrap it as `{ cellKey:'iframe-widget', props:{ typeKey } }`;
 * an already-wrapped `iframe-widget` ref or a genuinely-registered built-in cellKey
 * passes through unchanged. Without this, an agent-bound renderer (cellKey = the
 * create_cell typeKey) resolves to nothing at render time.
 */
async function buildCellRendererRef(
  cellKey: string,
  props?: Record<string, unknown>
): Promise<RendererRef> {
  if (cellKey !== "iframe-widget") {
    const db = await getDb();
    const rows = await db
      .select({ id: widgetDefinitions.id })
      .from(widgetDefinitions)
      .where(eq(widgetDefinitions.typeKey, cellKey))
      .limit(1);
    if (rows.length > 0) {
      return {
        kind: "cell",
        cellKey: "iframe-widget",
        props: { typeKey: cellKey, ...(props ?? {}) },
      };
    }
  }
  return { kind: "cell", cellKey, props: props ?? {} };
}

export const hubProfilesRouter = router({
  /**
   * List profiles accessible in a workspace
   * Requires: hub-protocol.read scope
   */
  listProfiles: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        input.workspaceId
      );
      const caller = regularProfilesRouter.createCaller(callerContext);
      return caller.list();
    }),

  /**
   * Create a profile (entity type definition)
   * Requires: hub-protocol.write scope
   * Governance: auto-approved (profile.create in DEFAULT_AUTO_APPROVE)
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
      })
    )
    .mutation(async ({ input, ctx }) => {
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
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        input.workspaceId
      );
      const caller = regularPropertyDefsRouter.createCaller(callerContext);
      const result = await caller.list();
      // Optionally filter by profileId
      if (input.profileId) {
        return {
          propertyDefs: result.propertyDefs.filter(
            (d: any) => d.profileId === input.profileId
          ),
        };
      }
      return result;
    }),

  /**
   * Get the effective renderer for a profile in a workspace, by slot.
   * External agents (Eve, IS) use this to discover how to surface an
   * entity profile without going through tRPC. Requires hub-protocol.read.
   *
   * Returns both slots when `slot` is omitted. Resolution mirrors the regular
   * tRPC procedure (workspace overlay → profile default → hardcoded fallback).
   */
  getEffectiveRenderers: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
        profileSlug: z.string(),
        slot: z.enum(["list", "detail"]).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        input.workspaceId
      );
      const caller = regularProfilesRouter.createCaller(callerContext);
      // TODO(slot): hub exposed a slot param the renderer API doesn't accept
      return caller.getEffectiveRenderers({
        profileSlug: input.profileSlug,
      });
    }),

  /**
   * Bind a cell as a profile's renderer (list | detail | dashboard).
   * Requires: hub-protocol.write scope.
   *
   * GOVERNANCE (locked): binding an AI-generated cell as a durable renderer is
   * consequential, so this routes through `checkPermissionOrPropose` with the
   * `profile` / `renderer.set` action — which is DELIBERATELY absent from
   * DEFAULT_AUTO_APPROVE (unlike `profile.update`). Agent callers therefore get
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
    .mutation(async ({ input }) => {
      const scope = input.scope ?? "workspace";
      const workspaceId = input.workspaceId ?? null;
      const ref: RendererRef = await buildCellRendererRef(
        input.cellKey,
        input.props
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
   * `entity/create` gate exactly. `property_def.create` is in
   * DEFAULT_AUTO_APPROVE, so a default-governance workspace still gets
   * instant apply; a workspace that narrows `autoApproveFor` (or runs in SAFE
   * mode) now correctly gets `status: 'proposed'` instead of an ungoverned
   * direct write. On approval, the `property_def/create` proposal executor
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
    .mutation(async ({ input }) => {
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
