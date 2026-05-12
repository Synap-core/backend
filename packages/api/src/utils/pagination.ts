/**
 * Standardized pagination for all list endpoints.
 *
 * Usage in a router:
 *   import { paginatedInput, buildPaginatedResponse } from "../utils/pagination.js";
 *
 *   list: protectedProcedure
 *     .input(paginatedInput.extend({ profileSlug: z.string().optional() }))
 *     .query(async ({ input, ctx }) => {
 *       const { limit, offset } = buildPaginationParams(input);
 *       const results = await db.query.entities.findMany({
 *         where: eq(entities.userId, ctx.userId),
 *         limit,
 *         offset,
 *         orderBy: [desc(entities.createdAt)],
 *       });
 *       return buildPaginatedResponse(results, input);
 *     }),
 *
 * The trick: query with `limit + 1` to detect `hasMore` without a COUNT query.
 * If we get back limit+1 rows, there are more results; we trim the extra row
 * before returning.
 *
 * Exports:
 * - paginatedInput: Zod schema for pagination input
 * - buildPaginatedResponse: Build response from query results
 * - buildPaginationParams: Returns limit+1, offset for queries
 * - normalizePaginationInput: Safe defaults for pagination
 * - createListInputSchema: Create input schema with filters
 */

import { z } from "zod";

/**
 * Zod schema for pagination input. Extend with `.extend({...})` for
 * endpoint-specific filters.
 */
export const paginatedInput = z.object({
  limit: z.number().min(1).max(1000).default(50),
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

// ── Additional Helpers ───────────────────────────────────────────────────────

/**
 * Calculate next offset for pagination.
 */
export function calculateNextOffset(
  currentOffset: number,
  limit: number,
  hasMore: boolean
): number | undefined {
  return hasMore ? currentOffset + limit : undefined;
}

/**
 * Build SQL limit/offset parameters.
 * Returns limit+1 to enable hasMore detection.
 */
export function buildPaginationParams(input: {
  limit: number;
  offset: number;
}): {
  limit: number;
  offset: number;
} {
  return {
    limit: input.limit + 1, // +1 to detect hasMore
    offset: input.offset,
  };
}

/**
 * Normalize pagination input with safe defaults.
 */
export function normalizePaginationInput(input: {
  limit?: number;
  offset?: number;
}): { limit: number; offset: number } {
  return {
    limit: Math.min(Math.max(1, input.limit ?? 50), 1000),
    offset: Math.max(0, input.offset ?? 0),
  };
}

/**
 * Standard filter input schema for list endpoints.
 * Extend this with endpoint-specific filters.
 */
export function createListInputSchema<T extends z.ZodRawShape>(
  filterSchema?: z.ZodObject<T>
) {
  const base = paginatedInput;
  return filterSchema ? base.merge(filterSchema.partial()) : base;
}
