/**
 * Places — "open where it lives" (CONNECT-AND-MIRROR-PLAN §W3).
 *
 * The pod decides; clients only dispatch. `openTarget` answers where opening an
 * entity should go: `external` (an https provider url — today a Google Calendar
 * event's `htmlLink`) when the caller bound `source-app` for that profile kind
 * and the entity carries an honest source url from their own connection, else
 * `internal`.
 */

import { z } from "zod";

import { router, podProcedure } from "../trpc.js";
import { resolveEntityOpenTarget } from "../services/places/resolve-open-target.js";

export const placesRouter = router({
  openTarget: podProcedure
    .input(z.object({ entityId: z.string().uuid() }))
    .query(({ input, ctx }) =>
      resolveEntityOpenTarget({
        entityId: input.entityId,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId ?? null,
      })
    ),
});
