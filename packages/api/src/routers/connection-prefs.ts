/**
 * `trpc.connectionPrefs.*` — the person's per-connection PIN and notify level
 * (Connected, founder decision 7). Store + merge door:
 * `notifications/connection-prefs.ts` (the pod-wide `notification_preferences`
 * row, column `connection_prefs`).
 *
 * `protectedProcedure`: a connection belongs to the person, not a workspace.
 * The floor is `ctx.userId` — a person reads and writes only their own row
 * (the same floor as `notifCenter.pushPrefs`). An agent key is refused on the
 * write: what the person pins and hears is theirs.
 */
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc.js";
import { requireUserId } from "../utils/user-scoped.js";
import {
  CONNECTION_PREF_DEFAULTS,
  connectionPrefPatchSchema,
  readConnectionPrefs,
  writeConnectionPref,
} from "../notifications/connection-prefs.js";

export const connectionPrefsRouter = router({
  /**
   * Every connection the person personalised, keyed `<kind>:<id>`, each with
   * its EFFECTIVE `{ pinned, notify }`. A key absent from `prefs` reads as
   * `defaults`. A failed read throws (isError) — never answered as `{}`.
   */
  list: protectedProcedure.query(async ({ ctx }) => ({
    prefs: await readConnectionPrefs(requireUserId(ctx.userId)),
    defaults: CONNECTION_PREF_DEFAULTS,
  })),

  /**
   * Pin/unpin a connection and/or set what the person hears about it. Merged
   * in SQL one key at a time: fields not named are left as stored.
   */
  set: protectedProcedure
    .input(connectionPrefPatchSchema)
    .mutation(async ({ ctx, input }) => {
      if (ctx.agentUserId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the person can change how they follow a connection.",
        });
      }
      return writeConnectionPref(requireUserId(ctx.userId), input);
    }),
});
