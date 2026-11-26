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
 * `surfaces.inspect` (Surfaces P7) reads what one framed surface does before
 * it is handed over: its frame reads, hard-coded colours and fonts, static
 * accessibility (the door MCP `synap_inspect_surface` and Hub REST
 * `GET /surfaces/inspect` share).
 *
 * Writes (Surfaces P3): `surfaces.create | attach | detach` put a surface ON
 * one object (links `attaches`), through the ONE governed service
 * (`services/surfaces/attach.ts`, `create.ts`) that MCP and Hub REST call too.
 * Kind-level renderer bindings keep flowing through `profiles.setRenderer`.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { requireUserId } from "../utils/user-scoped.js";
import { AccessContext } from "../access/context.js";
import { buildRendererUsage } from "../services/surfaces/renderer-usage.js";
import { surfacesForObject } from "../services/surfaces/for-object.js";
import { TRPCError } from "@trpc/server";
import {
  ANCHOR_KINDS,
  ATTACHABLE_SURFACE_TYPES,
  CREATABLE_SURFACE_BODIES,
} from "@synap-core/types/surfaces";
import {
  attachSurface,
  detachSurface,
  type SurfaceActor,
  type SurfaceDenied,
  type SurfaceRefusal,
} from "../services/surfaces/attach.js";
import { createSurface } from "../services/surfaces/create.js";
import {
  INSPECT_SURFACE_KINDS,
  inspectSurface,
} from "../services/surfaces/inspect.js";

const AnchorSchema = z.object({
  kind: z.enum(ANCHOR_KINDS),
  id: z.string().uuid(),
});
const SurfaceRefSchema = z.object({
  type: z.enum(ATTACHABLE_SURFACE_TYPES),
  id: z.string().uuid(),
});
const MetaFields = {
  slot: z.string().max(40).optional(),
  label: z.string().max(200).optional(),
};

/** A refusal or a denial is an error on tRPC; everything else is the answer. */
function settle<T extends { status: string }>(
  outcome: T | SurfaceRefusal | SurfaceDenied
): T {
  if (outcome.status === "refused") {
    const r = outcome as SurfaceRefusal;
    throw new TRPCError({
      code:
        r.httpStatus === 404
          ? "NOT_FOUND"
          : r.httpStatus === 403
            ? "FORBIDDEN"
            : "BAD_REQUEST",
      message: r.error,
    });
  }
  if (outcome.status === "denied") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: (outcome as SurfaceDenied).reason,
    });
  }
  return outcome as T;
}

function actorOf(
  ctx: {
    userId?: string | null;
    agentUserId?: string | null;
    sessionId?: string | null;
  },
  door: string
): SurfaceActor {
  return {
    userId: requireUserId(ctx.userId),
    agentUserId: ctx.agentUserId ?? null,
    sessionId: ctx.sessionId ?? null,
    door,
  };
}

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

  /**
   * Inspect ONE framed surface (a cell, an HTML page, a view's cells): its
   * frame reads (used, refused, declared vs used), hard-coded colours and
   * fonts, static accessibility. Each section is `ok` or `unavailable` with
   * its reason; `render` is always unavailable on the pod (no browser).
   */
  inspect: protectedProcedure
    .input(
      z.object({
        surface: z
          .object({
            kind: z.enum(INSPECT_SURFACE_KINDS),
            id: z.string().uuid().optional(),
            typeKey: z.string().min(1).max(200).optional(),
          })
          .refine((s) => !!s.id || (s.kind === "cell" && !!s.typeKey), {
            message: "Pass the surface's id (or a cell's typeKey).",
          }),
        workspaceId: z.string().uuid().nullish(),
        days: z.number().int().min(1).max(30).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return inspectSurface(
        { userId, access: AccessContext.from(ctx) },
        input
      );
    }),

  /**
   * Make a surface FOR one object: the body (view, bento, whiteboard,
   * document, html, cell) and its `attaches` edge, one governed act
   * (`surface/create`). `{status:'created', surface, openUrl}` or
   * `{status:'proposed', proposalId}`.
   */
  create: protectedProcedure
    .input(
      z.object({
        anchor: AnchorSchema,
        body: z.enum(CREATABLE_SURFACE_BODIES),
        title: z.string().min(1).max(200),
        spec: z
          .object({
            viewType: z.string().max(40).optional(),
            config: z.record(z.string(), z.unknown()).optional(),
            content: z.string().optional(),
            url: z.string().url().optional(),
            cellKey: z.string().max(200).optional(),
            props: z.record(z.string(), z.unknown()).optional(),
            workspaceId: z.string().uuid().optional(),
          })
          .optional(),
        reasoning: z.string().max(2000).optional(),
        ...MetaFields,
      })
    )
    .mutation(async ({ ctx, input }) =>
      settle(
        await createSurface(
          { ...actorOf(ctx, "surfaces.create"), reasoning: input.reasoning },
          input
        )
      )
    ),

  /**
   * Put an existing surface on one object (`surface/attach`). Both ends must
   * be visible to the caller. `{status:'attached'|'exists', linkId, openUrl}`
   * or `{status:'proposed', proposalId}`.
   */
  attach: protectedProcedure
    .input(
      z.object({
        anchor: AnchorSchema,
        surface: SurfaceRefSchema,
        position: z.number().int().min(0).optional(),
        reasoning: z.string().max(2000).optional(),
        ...MetaFields,
      })
    )
    .mutation(async ({ ctx, input }) =>
      settle(
        await attachSurface(
          { ...actorOf(ctx, "surfaces.attach"), reasoning: input.reasoning },
          input
        )
      )
    ),

  /** Take a surface off one object (`surface/detach`); the body stays. */
  detach: protectedProcedure
    .input(
      z.object({
        anchor: AnchorSchema,
        surface: SurfaceRefSchema,
        reasoning: z.string().max(2000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) =>
      settle(
        await detachSurface(
          { ...actorOf(ctx, "surfaces.detach"), reasoning: input.reasoning },
          input
        )
      )
    ),
});
