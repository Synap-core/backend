/**
 * tRPC Initialization - Phase 4: CQRS API Layer
 * 
 * Implements:
 * - Protected procedures with Better Auth + RLS
 * - Command procedures (publish events)
 * - Query procedures (read from projections)
 */

import { initTRPC, TRPCError } from '@trpc/server';
import type { Context } from './context.js';
import { requireUserId } from './utils/user-scoped.js';
import { config } from '@synap/core';
import { createLogger } from '@synap/core';

const logger = createLogger({ module: 'trpc' });
const isPostgres = config.database.dialect === 'postgres';

const t = initTRPC.context<Context>().create();

/**
 * Public procedure (no auth required)
 */
export const publicProcedure = t.procedure;

/**
 * Protected procedure (auth required + RLS)
 * 
 * Phase 4: Sets RLS for PostgreSQL to ensure user isolation
 */
export const protectedProcedure = t.procedure.use(async (opts) => {
  const { ctx } = opts;
  
  if (!ctx.authenticated) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }

  const userId = requireUserId(ctx.userId);

  // Phase 4: Set RLS for PostgreSQL
  if (isPostgres) {
    try {
      const { getSetCurrentUserFunction } = await import('@synap/database');
      const setCurrentUser = await getSetCurrentUserFunction();
      if (setCurrentUser) {
        await setCurrentUser(userId);
        logger.debug({ userId }, 'RLS current user set for tRPC request');
      }
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to set RLS current user');
      // Don't fail the request, but log the error
      // RLS will fall back to explicit user filtering
    }
  }
  
  return opts.next({
    ctx: {
      ...ctx,
      userId, // Ensure userId is always a string in protected procedures
    },
  });
});

export const router = t.router;
export const middleware = t.middleware;

