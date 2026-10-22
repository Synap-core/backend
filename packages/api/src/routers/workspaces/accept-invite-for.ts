/**
 * `acceptInviteFor` — the ONE door that turns an accepted invite into access.
 *
 * Three callers decide WHO accepts and refuse what they must (unknown, expired,
 * another email), each in its own error shape:
 *   - `workspaces.acceptInvite` (tRPC): a person signed in on the pod;
 *   - `workspaces.acceptInviteViaCp` (tRPC): the CP vouches for the email;
 *   - `POST /api/hub/setup/accept-invite` (REST): the console's
 *     "Create account and join", right after it made the account.
 * Before this door the REST path wrote bare `workspace_members` rows: no member
 * events, no `pod_members` row, no team-person bridge, no audit line, and the
 * CP's invite row stayed pending forever. All three now call this.
 *
 * Kept from the access rules it must not bend (console-security #72): a pod
 * invite fans out over ORDINARY spaces only (`listPodInviteFanOutWorkspaceIds`,
 * never a system space such as pod-admin), and `pod_members` records the
 * person as a plain member whatever the invite's role.
 */
import {
  db,
  eq,
  and,
  invites,
  podMembers,
  workspaceMembers,
  getDb,
  eventRepository,
  WorkspaceMemberRepository,
  ensureTeamPersonForMember,
  recordInviteAcceptance,
  listPodInviteFanOutWorkspaceIds,
} from "@synap/database";
import { auditLog } from "../../utils/audit-log.js";
import { logger, notifyCpInviteLifecycle } from "./helpers.js";

type InviteRow = typeof invites.$inferSelect;
type MemberRole = "owner" | "editor" | "viewer";

export type InviteAccepted =
  | { status: "accepted"; type: "workspace"; workspaceId: string }
  | { status: "accepted"; type: "pod"; workspacesJoined: number };

/**
 * Give `user` what `invite` offers, record the acceptance, spend the invite
 * and tell the CP. The caller has already checked the invite is open and
 * addressed to this person.
 */
export async function acceptInviteFor(
  invite: InviteRow,
  user: { id: string; email?: string | null },
  opts: { source?: "cp-proxy" } = {}
): Promise<InviteAccepted> {
  const dbConn = await getDb();
  // Shared singleton — a fresh EventRepository has no registered hooks, so
  // its emitCompleted() append would silently never reach the
  // realtime/materialization/sync hooks.
  const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepository);
  const role = invite.role as MemberRole;

  /** One space joined: the member event, the person bridge, the audit line. */
  const join = async (workspaceId: string): Promise<boolean> => {
    const already = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, user.id)
      ),
      columns: { id: true },
    });
    if (already) return false;
    const member = await memberRepo.add(
      { workspaceId, userId: user.id, role },
      user.id
    );
    // Team roster → person bridge (best-effort; never blocks membership)
    void ensureTeamPersonForMember(dbConn, {
      memberUserId: user.id,
      workspaceId,
      ownerUserId: invite.invitedBy ?? user.id,
    }).catch((err) => {
      logger.warn(
        { err, memberUserId: user.id, workspaceId },
        "Failed to ensure team person for member on invite accept"
      );
    });
    await auditLog({
      subjectType: "workspaceMember",
      action: "add",
      phase: "completed",
      subjectId: member.id,
      userId: user.id,
      workspaceId,
      data: {
        role: invite.role,
        invitedBy: invite.invitedBy,
        inviteId: invite.id,
        ...(opts.source ? { source: opts.source } : {}),
      },
    });
    return true;
  };

  let accepted: InviteAccepted;
  if (invite.type === "workspace") {
    if (!invite.workspaceId) {
      throw new Error(`Workspace invite ${invite.id} names no workspace`);
    }
    await join(invite.workspaceId);
    accepted = {
      status: "accepted",
      type: "workspace",
      workspaceId: invite.workspaceId,
    };
  } else {
    // Pod invite: durable pod membership (always a plain member), then the
    // ordinary spaces only — a system space (pod-admin) is never fanned into,
    // so an invite's role can never become pod admin.
    await db
      .insert(podMembers)
      .values({
        userId: user.id,
        podRole: "member",
        invitedBy: invite.invitedBy ?? null,
      })
      .onConflictDoNothing();
    const fanOutIds = await listPodInviteFanOutWorkspaceIds();
    for (const workspaceId of fanOutIds) await join(workspaceId);
    accepted = {
      status: "accepted",
      type: "pod",
      workspacesJoined: fanOutIds.length,
    };
  }

  await recordInviteAcceptance(invite, user.id);
  await db.delete(invites).where(eq(invites.id, invite.id));
  void notifyCpInviteLifecycle({
    inviteToken: invite.token,
    event: "accepted",
    actorEmail: user.email ?? undefined,
    actorUserId: user.id,
  });
  return accepted;
}
