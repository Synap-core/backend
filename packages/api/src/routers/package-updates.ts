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
  stopPackageUpdatesInputSchema,
  undoPackageUpdateInputSchema,
} from "@synap-core/types/package-updates";

import {
  router,
  podAdminProcedure,
  requireFreshAuthentication,
} from "../trpc.js";
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
import { setRendererBundleUpdatesStopped } from "../services/renderers/renderer-bundle-updates.js";

/** A config-lifecycle act is a person's: refuse an agent credential. */
function refuseAgent(ctx: { agentUserId?: string | null }, message: string) {
  if (getActingAgentUserId() ?? ctx.agentUserId) {
    throw new TRPCError({ code: "FORBIDDEN", message });
  }
}

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
  // A whole space update re-applies the template (`installTemplateFromCatalog`),
  // which can enrol agents in the space (workspace_members): a credential
  // write, so a device session needs a fresh sign-in, as `workspaces.installFromCatalog`.
  applyUpdate: podAdminProcedure
    .use(requireFreshAuthentication)
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

  /**
   * "Stop updates" for a package that stays installed from the catalog (a
   * renderer bundle: its code is the catalog's, so it cannot become the
   * person's), and back on. Stopped, a new version waits for the person: it is
   * still listed, and applies only when they apply it.
   */
  stopUpdates: podAdminProcedure
    .input(stopPackageUpdatesInputSchema)
    .mutation(({ ctx, input }) => {
      refuseAgent(
        ctx as { agentUserId?: string | null },
        "An agent credential cannot stop or resume a package's updates. Run it from a human/operator session."
      );
      return setRendererBundleUpdatesStopped({
        slug: input.slug,
        stopped: input.stopped,
        userId: ctx.userId as string,
      });
    }),
});
