/**
 * SURFACES router — the read side of the Surfaces plane (renderers, interfaces,
 * apps). Two doors: `surfaces.usageHealth` (which renderer keys are bound,
 * and are they healthy) and `surfaces.forObject` (which surfaces ONE object
 * carries, the find door MCP `synap_find_surfaces` and Hub REST
 * `GET /surfaces` share).
 *
 * ALTITUDE: `protectedProcedure` with an OPTIONAL `workspaceId`, exactly like
 * `capabilities.compositions` — the Surfaces app is a pod-altitude plane and
 * must not 400 when no workspace is selected. `workspaceId` NARROWS (pod-wide
 * NULL-workspace rows are always included); omitted ⇒ the pod-wide user floor.
 *
 * Pure read. No mutation door here yet — renderer binding writes keep flowing
 * through their existing governed doors (`profiles.setRenderer`,
 * `workspaces.update`, `views.update`).
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { requireUserId } from "../utils/user-scoped.js";
import { AccessContext } from "../access/context.js";
import { buildRendererUsage } from "../services/surfaces/renderer-usage.js";
import { surfacesForObject } from "../services/surfaces/for-object.js";
import { ANCHOR_KINDS } from "@synap-core/types/surfaces";

export const surfacesRouter = router({
  /**
   * Renderer USAGE-HEALTH — one row per DISTINCT bound renderer key, with every
   * binding that points at it (workspace overlay · profile default · per-view
   * ref), whether the key is registered server-side, and the gaps.
   *
   * `cellKey` narrows to a single key (the Renderers deep-dive panel).
   * `includeEntityBindings` is accepted but DEFERRED in v1 — per-entity
   * overrides are reported only as `perEntityOverrideCount`.
   */
  usageHealth: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().uuid().nullish(),
          cellKey: z.string().min(1).max(200).optional(),
          includeEntityBindings: z.boolean().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return buildRendererUsage({
        userId,
        workspaceId: input?.workspaceId ?? null,
        cellKey: input?.cellKey,
        includeEntityBindings: input?.includeEntityBindings ?? false,
        access: AccessContext.from(ctx),
      });
    }),

  /**
   * Every surface ONE object carries (`{rows, unavailable}`): its kind's
   * renderers, its body, views pinned to it, its home or start page, session
   * outputs and Sites — each store under its own visibility floor, a store
   * that failed named in `unavailable`. `workspaceId` NARROWS.
   */
  forObject: protectedProcedure
    .input(
      z.object({
        kind: z.enum(ANCHOR_KINDS),
        id: z.string().min(1).max(200),
        workspaceId: z.string().uuid().nullish(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return surfacesForObject(
        { userId, access: AccessContext.from(ctx) },
        input
      );
    }),
});
