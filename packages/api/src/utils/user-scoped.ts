/**
 * User-Scoped Query Helpers
 * 
 * These utilities ensure all database operations are scoped to the authenticated user.
 * This provides application-level multi-tenancy isolation.
 */

import { eq, and } from '@synap/database';
import type { SQL } from '@synap/database';
import { UnauthorizedError, ValidationError } from '@synap-core/types';

/**
 * Validates and returns userId, throwing if not present
 * 
 * @throws {UnauthorizedError} If userId is null or undefined
 */
export function requireUserId(userId?: string | null): string {
  if (!userId) {
    throw new UnauthorizedError('User ID is required for this operation');
  }
  return userId;
}

/**
 * Helper to create user-scoped WHERE clause
 * 
 * Usage:
 * ```typescript
 * const notes = await db.select()
 *   .from(entities)
 *   .where(userScope(entities.userId, ctx.userId));
 * ```
 */
export function userScope(userIdColumn: any, userId: string): SQL {
  return eq(userIdColumn, userId);
}

/**
 * Helper to combine user scope with other conditions
 * 
 * Usage:
 * ```typescript
 * const tasks = await db.select()
 *   .from(entities)
 *   .where(userScopeAnd(
 *     entities.userId,
 *     ctx.userId,
 *     eq(entities.type, 'task')
 *   ));
 * ```
 */
export function userScopeAnd(
  userIdColumn: any,
  userId: string,
  ...conditions: SQL[]
): SQL {
  return and(eq(userIdColumn, userId), ...conditions) as SQL;
}

/**
 * Type guard for event data that includes userId
 * Ensures projectors receive userId from events
 */
export interface EventDataWithUser {
  userId: string;
  [key: string]: any;
}

/**
 * Validates event data has required userId
 * 
 * @throws {ValidationError} If userId is missing from event data
 */
export function requireEventUserId(data: any): EventDataWithUser {
  if (!data.userId) {
    throw new ValidationError('Event data must include userId for multi-user isolation', { data });
  }
  return data as EventDataWithUser;
}

