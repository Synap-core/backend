import { z } from 'zod';
import { Inngest } from 'inngest';
import { router, protectedProcedure } from '../trpc.js';
import { suggestionService, SuggestionStatusSchema } from '@synap/domain';
import { requireUserId } from '../utils/user-scoped.js';

const inngest = new Inngest({ id: 'synap-api-suggestions' });

export const suggestionsRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({
          status: SuggestionStatusSchema.optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const suggestions = await suggestionService.listSuggestions({
        userId,
        status: input?.status,
      });

      return {
        suggestions,
        total: suggestions.length,
      };
    }),

  accept: protectedProcedure
    .input(z.object({ suggestionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const updated = await suggestionService.acceptSuggestion({
        userId,
        suggestionId: input.suggestionId,
      });

      await inngest.send({
        name: 'suggestion.accepted',
        data: {
          suggestionId: updated.id,
          userId: updated.userId,
          type: updated.type,
          payload: updated.payload ?? {},
          confidence: updated.confidence,
        },
      });

      return {
        status: 'accepted',
        suggestion: updated,
      };
    }),

  dismiss: protectedProcedure
    .input(z.object({ suggestionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const updated = await suggestionService.dismissSuggestion({
        userId,
        suggestionId: input.suggestionId,
      });

      return {
        status: 'dismissed',
        suggestion: updated,
      };
    }),
});


