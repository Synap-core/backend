/**
 * Standardized pagination for all list endpoints.
 *
 * Usage in a router:
 *   import { paginatedInput, buildPaginatedResponse } from "../utils/pagination.js";
 *
 *   list: protectedProcedure
 *     .input(paginatedInput.extend({ profileSlug: z.string().optional() }))
 *     .query(async ({ input, ctx }) => {
 *       const results = await db.query.entities.findMany({
 *         where: eq(entities.userId, ctx.userId),
 *         limit: input.limit + 1,  // fetch one extra to detect hasMore
 *         offset: input.offset,
 *         orderBy: [desc(entities.createdAt)],
 *       });
 *       return buildPaginatedResponse(results, input);
 *     }),
 *
 * The trick: query with `limit + 1` to detect `hasMore` without a COUNT query.
 * If we get back limit+1 rows, there are more results; we trim the extra row
 * before returning.
 */

import { z } from "zod";

/**
 * Zod schema for pagination input. Extend with `.extend({...})` for
 * endpoint-specific filters.
 */
export const paginatedInput = z.object({
  limit: z.number().min(1).max(100).default(50),
  offset: z.number().min(0).default(0),
});

export type PaginatedInput = z.infer<typeof paginatedInput>;

/**
 * Standard paginated response envelope.
 */
export type PaginatedResponse<T> = {
  items: T[];
  pagination: {
    hasMore: boolean;
    total?: number;
    limit: number;
    offset: number;
  };
};

/**
 * Build a paginated response from query results.
 *
 * @param items  - Results from a query that used `limit + 1` as its LIMIT.
 * @param input  - The pagination input (limit, offset) from the request.
 * @param total  - Optional total count (only include if you ran a separate COUNT).
 * @returns Standardized paginated response with `items` trimmed to `limit`.
 */
export function buildPaginatedResponse<T>(
  items: T[],
  input: { limit: number; offset: number },
  total?: number
): PaginatedResponse<T> {
  const hasMore = items.length > input.limit;
  const trimmed = hasMore ? items.slice(0, input.limit) : items;

  return {
    items: trimmed,
    pagination: {
      hasMore,
      limit: input.limit,
      offset: input.offset,
      ...(total !== undefined ? { total } : {}),
    },
  };
}
