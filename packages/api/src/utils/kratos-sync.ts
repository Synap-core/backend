/**
 * Kratos Webhook Utilities
 *
 * Syncs Kratos identities to Synap database and creates default workspaces
 */

import { kratosAdmin } from "@synap/auth";
import { getDb } from "@synap/database";
import {
  users,
  workspaces,
  workspaceMembers,
  invites,
} from "@synap/database/schema";
import { eq, and, gte } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "kratos-sync" });

/**
 * Sync user from Kratos to Synap DB
 * Called by webhook when identity is created/updated
 */
export async function syncUserFromKratos(identityId: string): Promise<void> {
  const db = await getDb();

  try {
    // Fetch identity from Kratos
    const { data: identity } = await kratosAdmin.getIdentity({
      id: identityId,
    });

    // Upsert user record
    await db
      .insert(users)
      .values({
        id: identity.id,
        email: identity.traits.email as string,
        name: (identity.traits.name as string) || null,
        emailVerified: identity.verifiable_addresses?.[0]?.verified || false,
        kratosIdentityId: identity.id,
        lastSyncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          email: identity.traits.email as string,
          name: (identity.traits.name as string) || null,
          emailVerified: identity.verifiable_addresses?.[0]?.verified || false,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        },
      });

    logger.info({ userId: identity.id }, "Synced user from Kratos");
  } catch (error) {
    logger.error({ err: error, identityId }, "Failed to sync user from Kratos");
    throw error;
  }
}

/**
 * Create default workspace for new user
 * Called by webhook when identity is created
 *
 * Security: Only allows account creation if:
 * 1. User has a pending workspace invite (email matches)
 * 2. User is the admin (ADMIN_EMAIL matches)
 *
 * @returns Workspace ID and assigned role
 * @throws Error if user has no invite and is not admin
 */
export async function createDefaultWorkspace(
  userId: string,
  traits: { name?: string; email: string }
): Promise<{ id: string; role: "admin" | "owner" | "editor" | "viewer" }> {
  const db = await getDb();
  const email = (traits.email as string).toLowerCase();

  try {
    // Check if this is admin email (admin can always create account)
    const adminEmail = process.env.ADMIN_EMAIL;
    const isAdmin = adminEmail && email === adminEmail.toLowerCase().trim();

    // Check for any pending invite (workspace OR pod) for this email
    const allInvites = await db.query.invites.findMany({
      where: gte(invites.expiresAt, new Date()),
    });
    const matchingInvites = allInvites
      .filter((invite) => invite.email.toLowerCase().trim() === email)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const pendingInvite = matchingInvites[0];

    // Check if user is already a workspace member (pre-added before registering)
    const existingMembership = await db.query.workspaceMembers.findFirst({
      where: eq(workspaceMembers.userId, userId),
    });

    // Security check: allow if admin, has invite, or already a member
    if (!pendingInvite && !isAdmin && !existingMembership) {
      logger.warn(
        { email, userId },
        "Registration rejected: No pending invite, not admin, not existing member"
      );
      throw new Error(
        "Registration not allowed. You must be invited to join a workspace first."
      );
    }

    // Case 1a: Pod invite → add to ALL workspaces on this pod
    if (pendingInvite?.type === "pod") {
      logger.info(
        { userId, email },
        "User has pod invite, joining all workspaces"
      );

      const allWorkspaces = await db.query.workspaces.findMany();
      let firstWorkspaceId = allWorkspaces[0]?.id;

      for (const ws of allWorkspaces) {
        const alreadyMember = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, ws.id),
            eq(workspaceMembers.userId, userId)
          ),
        });
        if (alreadyMember) {
          firstWorkspaceId ??= ws.id;
          continue;
        }
        await db.insert(workspaceMembers).values({
          workspaceId: ws.id,
          userId,
          role: pendingInvite.role,
          invitedBy: pendingInvite.invitedBy,
        });
        firstWorkspaceId ??= ws.id;
      }

      await db.delete(invites).where(eq(invites.id, pendingInvite.id));

      logger.info(
        { userId, workspaceCount: allWorkspaces.length },
        "User joined pod via pod invite"
      );

      return {
        id: firstWorkspaceId ?? "",
        role: pendingInvite.role as "admin" | "owner" | "editor" | "viewer",
      };
    }

    // Case 1b: Workspace invite → join that specific workspace
    if (pendingInvite?.type === "workspace") {
      logger.info(
        { workspaceId: pendingInvite.workspaceId, userId, email },
        "User has workspace invite, joining workspace"
      );

      // workspaceId is non-null for workspace-typed invites
      const workspaceId = pendingInvite.workspaceId!;

      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
      });
      if (!workspace) {
        logger.error(
          { workspaceId },
          "Invite references non-existent workspace"
        );
        throw new Error("Invalid workspace invite");
      }

      const alreadyMember = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId)
        ),
      });

      if (!alreadyMember) {
        await db.insert(workspaceMembers).values({
          workspaceId,
          userId,
          role: pendingInvite.role,
          invitedBy: pendingInvite.invitedBy,
        });
      }

      await db.delete(invites).where(eq(invites.id, pendingInvite.id));

      logger.info(
        { workspaceId, userId, role: pendingInvite.role },
        "User joined workspace via invite"
      );

      return {
        id: workspaceId,
        role: pendingInvite.role as "admin" | "owner" | "editor" | "viewer",
      };
    }

    // Case 1c: Already a member (pre-added before registering)
    if (existingMembership) {
      logger.info(
        { userId, workspaceId: existingMembership.workspaceId },
        "User already a workspace member, allowing registration"
      );
      return {
        id: existingMembership.workspaceId,
        role: existingMembership.role as
          | "admin"
          | "owner"
          | "editor"
          | "viewer",
      };
    }

    // Case 2: User is admin → Create new workspace
    if (isAdmin) {
      logger.info({ userId, email }, "Admin user, creating new workspace");

      const workspaceName = traits.name
        ? `${traits.name}'s Workspace`
        : "Admin Workspace";

      const [workspace] = await db
        .insert(workspaces)
        .values({
          ownerId: userId,
          name: workspaceName,
          type: "personal",
          settings: {},
        })
        .returning();

      // Add admin as workspace member with admin role
      await db.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId,
        role: "admin",
      });

      logger.info(
        { workspaceId: workspace.id, userId },
        "Created admin workspace"
      );

      return { id: workspace.id, role: "admin" };
    }

    // This should never be reached due to security check above, but TypeScript needs it
    throw new Error("Registration not allowed");
  } catch (error) {
    logger.error(
      { err: error, userId, email },
      "Failed to create/join workspace"
    );
    throw error;
  }
}
