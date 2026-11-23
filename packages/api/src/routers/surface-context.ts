/**
 * `surfaces.context` — what a frame anchored to an object is about, and the
 * brand it draws in (frame contract v3). Merged into the `surfaces` router
 * (`root.ts`), kept in its own file so the Surfaces doors (`surfaces.ts`)
 * and this one grow apart.
 *
 * A host (the web ViewFrame, the desktop's frames, pod admin's HTML and
 * module frames) asks once per frame and hands the answer to its frame:
 * `window.synap.context()` and the module frame's `synap:init`. Read-only,
 * as the viewer (`resolveSurfaceContext`): an anchor the viewer cannot read
 * is NOT_FOUND; an anchor with no project or no brand answers `brand: null`.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { router, protectedProcedure } from "../trpc.js";
import { requireUserId } from "../utils/user-scoped.js";
import {
  resolveSurfaceContext,
  SURFACE_CONTEXT_ANCHOR_KINDS,
} from "../services/surfaces/surface-context.js";

export const surfaceContextInput = z.object({
  kind: z.enum(SURFACE_CONTEXT_ANCHOR_KINDS),
  id: z.string().uuid(),
  /** The project the host is lensed on: used only where the anchor names none. */
  projectId: z.string().uuid().optional(),
  theme: z.enum(["light", "dark"]).optional(),
  locale: z
    .string()
    .regex(/^[a-z]{2}(-[A-Za-z]{2})?$/)
    .optional(),
});

export const surfaceContextRouter = router({
  context: protectedProcedure
    .input(surfaceContextInput)
    .query(async ({ ctx, input }) => {
      const result = await resolveSurfaceContext({
        userId: requireUserId(ctx.userId),
        anchor: { kind: input.kind, id: input.id },
        projectId: input.projectId,
        theme: input.theme,
        locale: input.locale,
      });
      if (!result.ok) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Nothing to show here: this object was not found.",
        });
      }
      return result.context;
    }),
});
