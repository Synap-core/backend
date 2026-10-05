/**
 * Brand — the client door to the ONE brand resolution (Content × Brand C2).
 *
 * `resolve` answers "which workspace is my brand?" by running the pod's own
 * `resolveBrandWorkspace` — the same function behind the Hub door
 * `GET /api/hub/brand/kit` that agents use — so the UI and agents can never
 * name different brands. A client cannot run the rule itself: the pod's floor
 * also admits workspaces the caller owns without a member row, and the
 * pod-default rung orders by `createdAt`, neither of which `workspaces.list`
 * exposes.
 *
 * Empty ≠ failed: "no brand" / "project not found" come back as a typed
 * `{ ok: false, reason }`; a failed read throws (a tRPC error), never `null`.
 */

import { z } from "zod";

import { router, protectedProcedure } from "../trpc.js";
import { resolveBrandWorkspace } from "../services/brand/brand-kit-service.js";

export const brandRouter = router({
  resolve: protectedProcedure
    .input(
      z.object({
        projectId: z.string().uuid().optional(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .query(({ input, ctx }) =>
      resolveBrandWorkspace({
        userId: ctx.userId,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
      })
    ),
});
