/**
 * Create Admin User — re-exports implementation for local `tsx` usage.
 * Bundled entry: `packages/api` → `dist/scripts/create-admin-cli.js` (Docker image).
 */

export { createAdminUser } from "../packages/api/src/scripts/create-admin-user.ts";
