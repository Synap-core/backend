/**
 * Shared agent-into-workspace enrollment — the single source of truth for
 * "add this agent user as a member of this workspace".
 *
 * Used by:
 *   - POST /workspaces/enroll-agent   (explicit enrollment)
 *   - POST /workspaces/packages/apply (auto-enroll the provisioning agent so its
 *     immediate onboarding writes pass workspace-membership RBAC and then
 *     auto-approve as normal, instead of collapsing into a contentless
 *     `workspace.join` proposal).
 *
 * The `(workspace_id, user_id)` unique index (migration 0164) makes
 * `onConflictDoNothing()` actually dedup, so re-enrollment is a safe no-op.
 */
import { db, users, workspaceMembers, eq } from "@synap/database";

export type AgentEnrollmentResult =
  | { status: "enrolled"; role: string }
  | { status: "already-member" }
  | { status: "not-an-agent" };

export async function enrollAgentInWorkspace(params: {
  workspaceId: string;
  agentUserId: string;
  /** Membership role to grant on first enrollment. Default "editor". */
  role?: "viewer" | "editor" | "admin" | "owner";
}): Promise<AgentEnrollmentResult> {
  const { workspaceId, agentUserId, role = "editor" } = params;

  // Defence-in-depth: only ever enroll real agent users.
  const [agentRow] = await db
    .select({ userType: users.userType })
    .from(users)
    .where(eq(users.id, agentUserId))
    .limit(1);
  if (agentRow?.userType !== "agent") return { status: "not-an-agent" };

  // `.returning()` is empty when the (workspace_id, user_id) row already exists
  // (the unique index turns the insert into a no-op), so it doubles as the
  // enrolled-vs-already-member signal.
  const inserted = await db
    .insert(workspaceMembers)
    .values({ workspaceId, userId: agentUserId, role })
    .onConflictDoNothing()
    .returning({ id: workspaceMembers.id });

  return inserted.length
    ? { status: "enrolled", role }
    : { status: "already-member" };
}
