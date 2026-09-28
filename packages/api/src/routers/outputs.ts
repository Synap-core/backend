/**
 * Outputs — what the caller's work PRODUCED, read pod-wide.
 *
 * `landed` is `projects.outputs` generalised (decision D-d): the same scan and
 * pager (`services/projects/project-outputs.ts`), the pod-wide session
 * population, plus actor and decision per row. Contract:
 * `@synap-core/types/landed` (`LandedObjectsPage`). See
 * `services/outputs/landed-outputs.ts`.
 *
 * BOUND (accepted for V1, 2026-09-28): one read scans the 200 most recently
 * ACTIVE sessions (`PROJECT_OUTPUTS_SESSION_SCAN`, the project door's bound).
 * Past that the page says `truncated: true` and the least recently active
 * sessions' outputs are absent from EVERY page — surfaces must say so, never
 * present the list as complete. Sessions are not pre-filtered by `since` in
 * SQL: nothing guarantees that producing an output bumps the session's
 * `updated_at`, so such a filter could silently drop landed objects.
 *
 * No Hub REST mirror: agents read their own session's outputs through
 * `focusSessions.outputs` / `get_session`; "what landed across the pod" is a
 * person's supervision read, not an agent door.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { LANDED_ACTOR_FILTERS } from "@synap-core/types/landed";
import { router, podProcedure } from "../trpc.js";
import { AccessContext } from "../access/index.js";
import {
  LANDED_OUTPUTS_MAX_LIMIT,
  listLandedOutputs,
} from "../services/outputs/landed-outputs.js";

export const outputsRouter = router({
  landed: podProcedure
    .input(
      z.object({
        /**
         * Same three-state lens as `signals`: a string = that workspace,
         * `null` = pod-personal only, absent = the WHOLE floor (never the
         * active-workspace header — see `floorLens` in `signals.ts`).
         */
        workspaceId: z.string().nullish(),
        projectId: z.string().uuid().optional(),
        /** ISO instant: only rows that landed (or were proposed) at or after it. */
        since: z.string().datetime({ offset: true }).optional(),
        actor: z.enum(LANDED_ACTOR_FILTERS).default("all"),
        cursor: z.string().min(1).optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(LANDED_OUTPUTS_MAX_LIMIT)
          .default(30),
      })
    )
    .query(async ({ ctx, input }) => {
      const page = await listLandedOutputs({
        access: AccessContext.from(ctx),
        workspaceLens: input.workspaceId,
        projectId: input.projectId,
        since: input.since,
        actor: input.actor,
        cursor: input.cursor,
        limit: input.limit,
      });
      if (!page) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
      }
      return page;
    }),
});
