/**
 * resolvePodOwnerUserId — the single source for "who owns this pod".
 *
 * The owner/admin member of the pod-admin system workspace. Null on a
 * pre-bootstrap pod (no owner yet). Shared by `ensureSynapCoreCapability`
 * (attributes the seed to the owner) and `notifyCapabilityUpdatesAvailable`
 * (the notification recipient) — one copy so the two never silently diverge.
 */
import {
  db,
  workspaces,
  workspaceMembers,
  eq,
  and,
  inArray,
} from "@synap/database";
import { sql as drizzleSql } from "drizzle-orm";

export async function resolvePodOwnerUserId(): Promise<string | null> {
  const podAdminWs = await db.query.workspaces.findFirst({
    where: drizzleSql`${workspaces.settings}->>'systemSlug' = 'pod-admin'`,
    columns: { id: true },
  });
  if (!podAdminWs) return null;

  const owner = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, podAdminWs.id),
      inArray(workspaceMembers.role, ["owner", "admin"])
    ),
    columns: { userId: true },
  });
  return owner?.userId ?? null;
}
