/**
 * Webhooks Router
 * 
 * Manages webhook subscriptions for n8n and other integrations.
 */

import { router, protectedProcedure } from '../trpc.js';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { createLogger } from '@synap-core/core';
import { db } from '@synap/database';
import { webhookSubscriptions, insertWebhookSubscriptionSchema } from '@synap/database/schema';
import { eq, and } from '@synap/database';
import { randomBytes } from 'crypto';

const logger = createLogger({ module: 'webhooks-router' });

/**
 * Webhook input schemas - TRUE SSOT using .omit()
 * 
 * Derived from: insertWebhookSubscriptionSchema (database/schema/webhook_subscriptions.ts)
 * Omits server-generated fields, keeps all user-provided fields.
 */

const UpdateWebhookInputSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100).optional(),
  url: z.string().url().optional(),
  eventTypes: z.array(z.string()).min(1).optional(),
  active: z.boolean().optional(),
});

export const webhooksRouter = router({
  /**
   * Create a new webhook subscription
   */
  create: protectedProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      url: z.string().url(),
      eventTypes: z.array(z.string()).min(1),
      secret: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;
      const secret = input.secret || randomBytes(32).toString('hex');

      logger.info({ userId, name: input.name, url: input.url }, 'Creating webhook subscription');

      try {
        const [subscription] = await db.insert(webhookSubscriptions).values({
          userId,
          name: input.name,
          url: input.url,
          eventTypes: input.eventTypes,
          secret,
          active: true,
        }).returning();

        return {
          subscription,
          secret, // Return secret only once upon creation
        };
      } catch (error) {
        logger.error({ err: error, userId }, 'Failed to create webhook subscription');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create webhook subscription',
        });
      }
    }),

  /**
   * List all webhook subscriptions for the current user
   */
  list: protectedProcedure
    .query(async ({ ctx }) => {
      const userId = ctx.userId;
      
      try {
        const subscriptions = await db.query.webhookSubscriptions.findMany({
          where: eq(webhookSubscriptions.userId, userId),
          orderBy: (subscriptions, { desc }) => [desc(subscriptions.createdAt)],
        });

        // Don't return secrets in list view
        return subscriptions.map(({ secret, ...sub }) => sub);
      } catch (error) {
        logger.error({ err: error, userId }, 'Failed to list webhook subscriptions');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to list webhook subscriptions',
        });
      }
    }),

  /**
   * Update a webhook subscription
   */
  update: protectedProcedure
    .input(UpdateWebhookInputSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;
      const { id, ...updates } = input;

      logger.info({ userId, webhookId: id }, 'Updating webhook subscription');

      try {
        // Check ownership
        const existing = await db.query.webhookSubscriptions.findFirst({
          where: and(
            eq(webhookSubscriptions.id, id),
            eq(webhookSubscriptions.userId, userId)
          ),
        });

        if (!existing) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Webhook subscription not found',
          });
        }

        const [updated] = await db.update(webhookSubscriptions)
          .set(updates)
          .where(eq(webhookSubscriptions.id, id))
          .returning();

        const { secret, ...safeSubscription } = updated;
        return safeSubscription;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        
        logger.error({ err: error, userId, webhookId: id }, 'Failed to update webhook subscription');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update webhook subscription',
        });
      }
    }),

  /**
   * Delete a webhook subscription
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;

      logger.info({ userId, webhookId: input.id }, 'Deleting webhook subscription');

      try {
        const result = await db.delete(webhookSubscriptions)
          .where(and(
            eq(webhookSubscriptions.id, input.id),
            eq(webhookSubscriptions.userId, userId)
          ))
          .returning();

        if (result.length === 0) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Webhook subscription not found',
          });
        }

        return { success: true };
      } catch (error) {
        if (error instanceof TRPCError) throw error;

        logger.error({ err: error, userId, webhookId: input.id }, 'Failed to delete webhook subscription');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete webhook subscription',
        });
      }
    }),
});
