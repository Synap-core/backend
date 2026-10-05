/**
 * Brand — the client door to the ONE brand resolution (Content × Brand C2).
 *
 * `resolve` answers "which brand applies here?" — the Brand space and the
 * brand identity inside it for the given project (or the default brand) — by
 * running the pod's own `resolveBrand`, the same function behind the Hub door
 * `GET /api/hub/brand/kit` that agents use, so the UI and agents can never
 * name different brands. A client cannot run the rule itself: the pod's floor,
 * the oldest-first order and project membership are not visible to it.
 *
 * Empty ≠ failed: `no-brand-space` / `no-brand-for-project` /
 * `no-default-brand` come back as a typed `{ ok: false, reason, message }`; a
 * failed read throws (a tRPC error), never `null`.
 */

import { z } from "zod";

import { router, protectedProcedure } from "../trpc.js";
import { resolveBrand } from "../services/brand/brand-kit-service.js";

export const brandRouter = router({
  resolve: protectedProcedure
    .input(
      z.object({
        projectId: z.string().uuid().optional(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .query(
      async ({ input, ctx }) =>
        (
          await resolveBrand({
            userId: ctx.userId,
            projectId: input.projectId,
            workspaceId: input.workspaceId,
          })
        ).resolution
    ),
});
