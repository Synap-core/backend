/**
 * tRPC Initialization - CQRS API Layer
 *
 * Security Model:
 * - Authentication: Ory Kratos session validation
 * - Authorization: Worker-based permissions (permissionValidator)
 * - Database Queries: Explicit userId filters
 *
 * Commands publish events → Workers validate permissions → DB operations
 */

import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { Context } from "./context.js";
import { requireUserId } from "./utils/user-scoped.js";
import { createLogger } from "@synap-core/core";
import "@synap/database"; // Fix TS2742: inferred type portability

const logger = createLogger({ module: "trpc" });

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

/**
 * Public procedure (no auth required)
 */
export const publicProcedure = t.procedure;

/**
 * Protected procedure (auth required)
 *
 * Validates Ory Kratos session. Authorization handled by permissionValidator worker.
 */
export const protectedProcedure = t.procedure.use(async (opts) => {
  const { ctx } = opts;

  if (!ctx.authenticated) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }

  const userId = requireUserId(ctx.userId);

  logger.debug({ userId }, "Protected procedure - authentication validated");

  return opts.next({
    ctx: {
      ...ctx,
      userId, // Ensure userId is always a string in protected procedures
    },
  });
});

export const router = t.router;
export const middleware = t.middleware;
