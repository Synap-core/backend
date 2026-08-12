/**
 * backfillAllWorkspacesTeamPersonBridge
 * ======================================
 *
 * Boot-time convergence for the team roster → person bridge
 * (`team-person-bridge.ts`). `ensureTeamPersonForMember` already runs
 * best-effort on every membership-changing mutation (invite accept, add
 * member, …), but that only ever reached members who joined AFTER the bridge
 * shipped. Existing workspace members never got a person entity +
 * `team-member` facet retrofitted. `workspaces.backfillTeamPersonBridge` (the
 * tRPC door) fixes one workspace at a time but is owner/admin-triggered —
 * nothing ever called it.
 *
 * This runs the SAME door (`backfillTeamPersonBridge`, the one door — never
 * reimplemented here) for every workspace on every boot. Idempotent + additive
 * (`ensureTeamPersonForMember` per member is itself idempotent — see its
 * docstring) and non-fatal per workspace, mirroring
 * `reconcileWorkspacesToTemplates`'s stance.
 */

import { createLogger } from "@synap-core/core";
import {
  getDb,
  workspaces,
  backfillTeamPersonBridge,
  resolveWorkspaceOwnerUserId,
} from "@synap/database";

const logger = createLogger({ module: "backfill-team-person-bridge" });

export async function backfillAllWorkspacesTeamPersonBridge(): Promise<void> {
  const db = await getDb();

  const rows = await db
    .select({ id: workspaces.id, ownerId: workspaces.ownerId })
    .from(workspaces);

  let converged = 0;
  let skipped = 0;
  let failed = 0;
  let created = 0;
  let linked = 0;

  for (const ws of rows) {
    try {
      const ownerUserId =
        (await resolveWorkspaceOwnerUserId(db, ws.id)) ?? ws.ownerId;
      if (!ownerUserId) {
        skipped++;
        continue;
      }
      const result = await backfillTeamPersonBridge(db, {
        workspaceId: ws.id,
        ownerUserId,
      });
      created += result.created;
      linked += result.linked;
      converged++;
    } catch (err) {
      failed++;
      logger.warn(
        { err, workspaceId: ws.id },
        "Team-person bridge backfill failed for workspace (non-fatal)"
      );
    }
  }

  if (created > 0 || linked > 0 || failed > 0) {
    logger.info(
      { converged, skipped, failed, created, linked, total: rows.length },
      "Team-person bridge backfill pass complete"
    );
  }
}
