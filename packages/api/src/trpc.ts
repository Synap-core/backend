/**
 * tRPC Initialization
 */

import { initTRPC, TRPCError } from '@trpc/server';
import type { Context } from './context.js';

const t = initTRPC.context<Context>().create();

/**
 * Public procedure (no auth required)
 */
export const publicProcedure = t.procedure;

/**
 * Protected procedure (auth required)
 */
export const protectedProcedure = t.procedure.use(async (opts) => {
  const { ctx } = opts;
  
  if (!ctx.authenticated) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Invalid or missing SYNAP_SECRET_TOKEN',
    });
  }
  
  return opts.next({
    ctx,
  });
});

export const router = t.router;
export const middleware = t.middleware;

