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
 *
 * Turning a verb ON also turns on the TOOLS it `requires` (`tools.approved`).
 * A verb has two switches: its skill (checked when it is asked for) and its
 * tool (checked when the call is dispatched: `external-dispatch.ts`, every
 * write and every code verb). The capability page's switch flipped only the
 * skill, so a pack read "6 of 6 on" while its tool stayed a draft: its reads
 * ran (a declarative GET skips the tool gate), every write the person approved
 * then failed at apply with "installed but not enabled", and
 * `synap_list_capabilities` said "off" (live pod, hetzner_cloud, 2026-10-30).
 * The `capability.enable` executor already turns a pack's skills AND tools on;
 * this door now does the same for the tools one verb needs. Each tool is gated
 * on ITS OWN scope (a space's owner, or a pod admin for a pod-wide tool) —
 * one the caller may not approve, or a public form row (the forms door is its
 * only writer), is left as it is. Turning a verb OFF leaves its tools alone:
 * another verb may use them.
 */
import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  inArray,
  skills,
  tools,
  links,
  getActingAgentUserId,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  getWorkspaceRole,
  requirePodAdmin,
} from "../../utils/workspace-role.js";
import { auditLog } from "../../utils/audit-log.js";
import { enqueueSyncForCapability } from "./capability-nango-sync.js";
import { invalidateUrlReaderCache } from "./url-reader-cache.js";
import { isFormToolMetadata } from "../forms/form-definition.js";

const logger = createLogger({ module: "set-skill-approved" });

/**
 * Approval is the HUMAN step: turning a verb or a tool ON is the owner's OK
 * that an agent-authored skill may run or load. An agent key is remapped to
 * its human owner (`userId` = the human), so the owner-role check below reads
 * a human and passes — an agent could approve its OWN draft. Refuse any acting
 * agent: the server-side ALS every key door enters (`runWithActingAgent`, which
 * a caller cannot drop) or a caller-supplied one. Same rule as
 * `rejectAgentReviewer` on proposals (an agent may never approve).
 */
export function refuseAgentApprover(agentUserId?: string | null): void {
  if (agentUserId ?? getActingAgentUserId()) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "An agent credential cannot approve — approval is the human step. Approve from a human session.",
    });
  }
}

export async function setSkillApproved(input: {
  userId: string;
  skillId: string;
  approved: boolean;
  /** The caller's acting agent when the door knows it (`ctx.agentUserId`). */
  agentUserId?: string | null;
}) {
  refuseAgentApprover(input.agentUserId);
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
  invalidateUrlReaderCache(); // a reader verb may have turned on or off

  auditLog({
    subjectType: "skill",
    action: "update",
    phase: "completed",
    subjectId: input.skillId,
    userId: input.userId,
    workspaceId: existing.workspaceId || undefined,
    data: { approved: input.approved },
  });

  const toolsTurnedOn = input.approved
    ? await approveRequiredTools(input.skillId, input.userId)
    : [];

  if (
    input.approved &&
    (existing.approved !== true || toolsTurnedOn.length > 0)
  ) {
    await resyncPacksOf(input.skillId);
  }
  return updated!;
}

/** May `userId` approve a row of this scope? The same rule as the skill's
 *  own gate above and `tools.setApproved`, answered instead of thrown. */
async function mayApproveInScope(
  userId: string,
  workspaceId: string | null
): Promise<boolean> {
  if (workspaceId) {
    return (await getWorkspaceRole(userId, workspaceId)) === "owner";
  }
  try {
    await requirePodAdmin(userId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn on the draft tools this verb `requires` (see the header). Returns the
 * ids it turned on.
 */
async function approveRequiredTools(
  skillId: string,
  userId: string
): Promise<string[]> {
  const edges = await db
    .select({ toolId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "skill"),
        eq(links.fromId, skillId),
        eq(links.toType, "tool"),
        eq(links.linkType, "requires")
      )
    );
  const toolIds = [...new Set(edges.map((e) => String(e.toolId)))];
  if (toolIds.length === 0) return [];
  const drafts = await db
    .select({
      id: tools.id,
      workspaceId: tools.workspaceId,
      metadata: tools.metadata,
    })
    .from(tools)
    .where(and(inArray(tools.id, toolIds), eq(tools.approved, false)));

  const turnedOn: string[] = [];
  for (const tool of drafts) {
    if (isFormToolMetadata(tool.metadata)) continue;
    if (!(await mayApproveInScope(userId, tool.workspaceId ?? null))) {
      logger.info(
        { skillId, toolId: tool.id },
        "verb turned on, but the caller may not turn on its tool"
      );
      continue;
    }
    await db
      .update(tools)
      .set({ approved: true, updatedAt: new Date() })
      .where(eq(tools.id, tool.id));
    auditLog({
      subjectType: "tool",
      action: "update",
      phase: "completed",
      subjectId: tool.id,
      userId,
      workspaceId: tool.workspaceId || undefined,
      data: { approved: true, viaSkillId: skillId },
    });
    turnedOn.push(tool.id);
  }
  return turnedOn;
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
