/**
 * Users Router - Current User API
 *
 * Exposes the authenticated user's identity and profile data.
 */

import { router, protectedProcedure } from "../trpc.js";
import { db, eq } from "@synap/database";
import { users } from "@synap/database/schema";

export const usersRouter = router({
  /**
   * Get the currently authenticated user's identity.
   * Returns Kratos session data merged with DB fields (name, avatarUrl, timezone, locale).
   */
  me: protectedProcedure.query(async ({ ctx }) => {
    const dbUser = await db.query.users.findFirst({
      where: eq(users.id, ctx.userId),
      columns: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        timezone: true,
        locale: true,
      },
    });

    return {
      id: ctx.userId,
      email: dbUser?.email ?? ctx.user?.email ?? "",
      name: dbUser?.name ?? ctx.user?.name ?? null,
      avatarUrl: dbUser?.avatarUrl ?? null,
      timezone: dbUser?.timezone ?? "UTC",
      locale: dbUser?.locale ?? "en",
    };
  }),
});
