/**
 * Entities Router — the body escalation ("Open as document", text tiers W3).
 *
 * `promotePropertyToBody` moves a body-eligible text property into the entity's
 * body document in one transaction; `undoPromotePropertyToBody` moves it back
 * while the document is still exactly what was moved. Both are refusals-as-data
 * (`status: "refused"` + a stable `reason`), never a thrown error, for the
 * refusals a surface should word; access failures stay NOT_FOUND / FORBIDDEN.
 */

import { z } from "zod";
import { podProcedure } from "../../trpc.js";
import {
  promotePropertyToBody,
  undoPromotePropertyToBody,
} from "../../services/entity-body/promote-property-to-body.js";

export const bodyProcs = {
  promotePropertyToBody: podProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        propertySlug: z.string().min(1),
      })
    )
    .mutation(({ input, ctx }) =>
      promotePropertyToBody({
        userId: ctx.userId,
        entityId: input.id,
        propertySlug: input.propertySlug,
      })
    ),

  undoPromotePropertyToBody: podProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        documentId: z.string().uuid(),
      })
    )
    .mutation(({ input, ctx }) =>
      undoPromotePropertyToBody({
        userId: ctx.userId,
        entityId: input.id,
        documentId: input.documentId,
      })
    ),
};
