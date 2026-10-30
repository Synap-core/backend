/**
 * packageUpdates — pod admin's doors over package updates: the list, one
 * update's plan, the apply with a choice per field, Undo, History and "Stop
 * updates". Every procedure calls the one service in
 * `services/package-updates/` (the Hub REST `/package-updates` routes call the
 * same functions), so pod admin, the CLI and agents read one plan.
 *
 * Pod admins only: an update changes what the pod's agents load. Writes go
 * through each row's own governed `.update` door as the caller, so an agent's
 * apply or undo is filed as a proposal there.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getActingAgentUserId } from "@synap/database";
import {
  applyPackageUpdateInputSchema,
  detachPackageInputSchema,
  undoPackageUpdateInputSchema,
} from "@synap-core/types/package-updates";

import { router, podAdminProcedure } from "../trpc.js";
import {
  getPackageUpdatePlan,
  listPackageUpdates,
} from "../services/package-updates/plan.js";
import {
  applyPackageUpdate,
  undoPackageUpdate,
} from "../services/package-updates/apply.js";
import { listPackageUpdateReceipts } from "../services/package-updates/receipts.js";
import { detachStandaloneConfigSource } from "../services/capabilities/reconcile-standalone-configs-to-templates.js";

export const packageUpdatesRouter = router({
  /** Every installed package whose catalog moved, and those it could not read. */
  list: podAdminProcedure.query(() => listPackageUpdates()),

  /** One update, field by field, with the values and the merges. */
  get: podAdminProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(({ input }) => getPackageUpdatePlan(input.slug)),

  /**
   * Apply with a choice per field; CONFLICT when the catalog moved since
   * `get`. Not named `apply`: tRPC reserves `apply`, `call` and `then` as
   * procedure names (a router using one fails to build).
   */
  applyUpdate: podAdminProcedure
    .input(applyPackageUpdateInputSchema)
    .mutation(({ ctx, input }) => applyPackageUpdate(ctx, input)),

  /** Take an update back within 30 days. */
  undo: podAdminProcedure
    .input(undoPackageUpdateInputSchema)
    .mutation(({ ctx, input }) => undoPackageUpdate(ctx, input.receiptId)),

  /** What updates changed, newest first: by a person or on their own. */
  history: podAdminProcedure
    .input(
      z
        .object({
          slug: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .optional()
    )
    .query(({ input }) =>
      listPackageUpdateReceipts({ slug: input?.slug, limit: input?.limit })
    ),

  /**
   * "Stop updates": the twin of Hub REST `POST /configs/detach`, refused to an
   * agent in the same words (a config-lifecycle act is a person's).
   */
  detach: podAdminProcedure
    .input(detachPackageInputSchema)
    .mutation(({ ctx, input }) => {
      if (
        getActingAgentUserId() ??
        (ctx as { agentUserId?: string | null }).agentUserId
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "An agent credential cannot detach a config from its template. Run it from a human/operator session.",
        });
      }
      return detachStandaloneConfigSource({
        kind: input.kind,
        id: input.id,
        userId: ctx.userId as string,
      });
    }),
});
