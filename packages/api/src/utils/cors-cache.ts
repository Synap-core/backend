/**
 * Dynamic CORS origins cache.
 *
 * Origins stored in workspace settings (`corsAllowedOrigins`) are loaded at
 * startup and kept in this module-level cache so the synchronous CORS
 * middleware can check them without a DB round-trip per request.
 *
 * The cache is refreshed:
 *  - Once at server startup via `runStartupHooks()`
 *  - Immediately after a successful `system.updateCorsSettings` mutation
 */

let dynamicOrigins: string[] = [];

export function getDynamicCorsOrigins(): string[] {
  return dynamicOrigins;
}

export function setDynamicCorsOrigins(origins: string[]): void {
  dynamicOrigins = origins.filter(Boolean);
}
