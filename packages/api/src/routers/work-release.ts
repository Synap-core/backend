/**
 * Work › Ship — `workRelease.get`: can I release, and what blocks it.
 *
 * One read (`services/dev-loop/work-release.ts`), folded by the ONE rule
 * (`foldWorkRelease`, `@synap-core/types/work-release`). The same read serves
 * Hub `GET /work-release` and MCP `synap_get_work_release`. Floored on the
 * reader: the snapshots under the event read rule, the sessions under the
 * session read rule (with the room roster on this human door, as `list`).
 */

import { router, protectedProcedure } from "../trpc.js";
import { rosterReadFor } from "../access/session-visibility.js";
import { readWorkRelease } from "../services/dev-loop/work-release.js";
import { requireUserId } from "../utils/user-scoped.js";

export const workReleaseRouter = router({
  get: protectedProcedure.query(({ ctx }) =>
    readWorkRelease({
      userId: requireUserId(ctx.userId),
      roster: rosterReadFor(ctx),
    })
  ),
});
