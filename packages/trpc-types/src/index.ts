/**
 * Shared tRPC types for Synap
 * Re-exports AppRouter from backend for frontend type safety
 * 
 * Usage in frontend:
 * ```typescript
 * import { createTRPCReact } from '@trpc/react-query';
 * import type { AppRouter } from '@synap/trpc-types';
 * 
 * export const api = createTRPCReact<AppRouter>();
 * ```
 */

// Re-export AppRouter type from backend
export type { AppRouter } from '@synap/api';
