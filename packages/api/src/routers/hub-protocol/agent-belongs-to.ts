import { and, apiKeys, db, eq, users } from "@synap/database";
import { isPodAdmin } from "../../utils/workspace-role.js";

/**
 * Does `agentUserId` act for `userId`? Its creator (`users.created_by_user_id`),
 * or the person an active key of the agent is linked to (the
 * `resolveActorId` rule). An agent with no human owner (a system persona) is
 * attributable by a pod admin only.
 */
export async function agentBelongsTo(
  userId: string,
  agentUserId: string
): Promise<boolean> {
  const [agent] = await db
    .select({ id: users.id, createdByUserId: users.createdByUserId })
    .from(users)
    .where(and(eq(users.id, agentUserId), eq(users.userType, "agent")))
    .limit(1);
  if (!agent) return false;
  if (agent.createdByUserId === userId) return true;
  const [linked] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, agentUserId),
        eq(apiKeys.linkedUserId, userId),
        eq(apiKeys.isActive, true)
      )
    )
    .limit(1);
  if (linked) return true;
  if (!agent.createdByUserId || agent.createdByUserId === agent.id) {
    return isPodAdmin(userId);
  }
  return false;
}
