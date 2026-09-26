/**
 * ONE door for turning a capability verb (its backing skill) on or off.
 *
 * `skills.setApproved` and `capabilities.setToolEnabled` each carried their own
 * copy of the gate and the write, and had already drifted: only one wrote an
 * audit entry. Both now call this, and so does the `capability.enable` executor
 * (through `skills.setApproved`), so a verb enabled from ANY surface gets the
 * same gate, the same audit, and the same follow-up.
 *
 * Gate: a workspace-scoped skill needs the workspace OWNER; a pod-wide
 * (null-workspace) skill needs pod admin — it is visible in every workspace.
 *
 * Follow-up: turning a verb ON re-queues the connections of the pack it belongs
 * to, so a sync that failed for want of it runs again instead of showing a
 * stale "not turned on". Best-effort — the enable itself has already landed.
 */
import { TRPCError } from "@trpc/server";
import { db, and, eq, skills, links } from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  getWorkspaceRole,
  requirePodAdmin,
} from "../../utils/workspace-role.js";
import { auditLog } from "../../utils/audit-log.js";
import { enqueueSyncForCapability } from "./capability-nango-sync.js";

const logger = createLogger({ module: "set-skill-approved" });

export async function setSkillApproved(input: {
  userId: string;
  skillId: string;
  approved: boolean;
}) {
  const existing = await db.query.skills.findFirst({
    where: eq(skills.id, input.skillId),
  });
  if (!existing) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Skill not found" });
  }
  if (existing.workspaceId) {
    const role = await getWorkspaceRole(input.userId, existing.workspaceId);
    if (role !== "owner") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Only workspace owners can turn this verb on or off.",
      });
    }
  } else {
    await requirePodAdmin(input.userId);
  }

  const [updated] = await db
    .update(skills)
    .set({ approved: input.approved, updatedAt: new Date() })
    .where(eq(skills.id, input.skillId))
    .returning();

  auditLog({
    subjectType: "skill",
    action: "update",
    phase: "completed",
    subjectId: input.skillId,
    userId: input.userId,
    workspaceId: existing.workspaceId || undefined,
    data: { approved: input.approved },
  });

  if (input.approved && existing.approved !== true) {
    await resyncPacksOf(input.skillId);
  }
  return updated!;
}

async function resyncPacksOf(skillId: string): Promise<void> {
  try {
    const packs = await db
      .select({ id: links.toId })
      .from(links)
      .where(
        and(
          eq(links.fromType, "skill"),
          eq(links.fromId, skillId),
          eq(links.toType, "capability"),
          eq(links.linkType, "member_of")
        )
      );
    for (const pack of packs) {
      await enqueueSyncForCapability(String(pack.id));
    }
  } catch (err) {
    logger.warn(
      { err, skillId },
      "verb enabled, but re-queueing its pack's connection sync failed"
    );
  }
}
