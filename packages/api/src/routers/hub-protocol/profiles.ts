/**
 * Hub Protocol - Profiles & Property Defs Router
 *
 * Exposes entity schema management to Intelligence Hub agents.
 * Profiles define entity types; property defs define custom fields.
 *
 * Governance:
 *   - All profile + property-def create/update ops are AUTO-APPROVED
 *     (view.create, profile.create, profile.update, property_def.create, property_def.update
 *     are in DEFAULT_AUTO_APPROVE — schema evolution is non-destructive and reversible).
 *   - No delete endpoints exposed to agents.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { profilesRouter as regularProfilesRouter } from "../profiles.js";
import { propertyDefsRouter as regularPropertyDefsRouter } from "../property-defs.js";
import { createHubProtocolCallerContext } from "./utils.js";

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
   * External agents (Eve, Hermes, IS) use this to discover how to surface an
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
   * Create a property definition for a profile.
   *
   * Requires: hub-protocol.write scope
   * Governance: auto-approved (property_def.create in DEFAULT_AUTO_APPROVE)
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
        /**
         * When true, create a workspace-scoped overlay (invisible to other
         * workspaces). Requires `workspaceId`. Default false = base def.
         */
        overlay: z.boolean().optional(),
        /** Target workspace for overlay creation. */
        workspaceId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const overlay = input.overlay === true;
      if (overlay && !input.workspaceId) {
        throw new Error("createPropertyDef: overlay=true requires workspaceId");
      }
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        // Overlays need workspace context so ctx.workspaceId is populated;
        // base defs can skip it (the regular router's workspaceProcedure
        // will still demand some workspace, but one will be resolved).
        overlay ? input.workspaceId : input.workspaceId,
        ctx.sourceMessageId ?? undefined
      );
      const caller = regularPropertyDefsRouter.createCaller(callerContext);

      return caller.create({
        slug: input.slug,
        valueType: input.valueType as
          | "string"
          | "number"
          | "boolean"
          | "object"
          | "array"
          | "date"
          | "secret"
          | "entity_id",
        constraints: input.constraints,
        uiHints: input.uiHints,
        profileId: input.profileId,
        overlay,
      });
    }),
});
