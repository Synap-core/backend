/**
 * Workspace-identity diagnostic / backfill runner.
 *
 *   REPORT (read-only, the default — prints, never writes):
 *     cd synap-backend && npx tsx --env-file=.env scripts/workspace-identity.ts
 *
 *   STAMP (writes only UNAMBIGUOUS matches; every stamp is logged with its evidence):
 *     cd synap-backend && npx tsx --env-file=.env scripts/workspace-identity.ts --stamp
 *
 * Both read `DATABASE_URL` from the environment, so pointing this at a pod is
 * an explicit, deliberate act. Re-running --stamp is a no-op: an identity that
 * exists is never overwritten.
 */

import {
  backfillWorkspaceIdentity,
  formatIdentityReport,
} from "../apps/api/src/startup/backfill-workspace-identity.js";

const stamp =
  process.argv.includes("--stamp") ||
  process.env.WORKSPACE_IDENTITY_BACKFILL === "stamp";

const result = await backfillWorkspaceIdentity({ stamp });
console.log(formatIdentityReport(result));
process.exit(0);
