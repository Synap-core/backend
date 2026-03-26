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
import { eq, and, gte } from "drizzle-orm";
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

    // Check for pending workspace invite (case-insensitive email match)
    // Note: We fetch all non-expired invites and filter by email in memory
    // This is acceptable since there should be few invites per email
    const allInvites = await db.query.invites.findMany({
      where: and(
        eq(invites.type, "workspace"),
        gte(invites.expiresAt, new Date())
      ),
    });

    // Find most recent invite with matching email (case-insensitive)
    const matchingInvites = allInvites.filter(
      (invite) => invite.email.toLowerCase().trim() === email
    );

    // Sort by createdAt descending and take the most recent
    const pendingInvite = matchingInvites.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    )[0];

    // Security check: User must have invite OR be admin
    if (!pendingInvite && !isAdmin) {
      logger.warn(
        { email, userId },
        "Registration rejected: No pending invite and not admin"
      );
      throw new Error(
        "Registration not allowed. You must be invited to join a workspace first."
      );
    }

    // Case 1: User has pending invite → Join existing workspace
    if (pendingInvite) {
      logger.info(
        { workspaceId: pendingInvite.workspaceId, userId, email },
        "User has pending invite, joining existing workspace"
      );

      // Check if workspace exists
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, pendingInvite.workspaceId),
      });

      if (!workspace) {
        logger.error(
          { workspaceId: pendingInvite.workspaceId },
          "Invite references non-existent workspace"
        );
        throw new Error("Invalid workspace invite");
      }

      // Check if user is already a member (prevent duplicates)
      const existingMember = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, pendingInvite.workspaceId),
          eq(workspaceMembers.userId, userId)
        ),
      });

      if (existingMember) {
        logger.info(
          { workspaceId: pendingInvite.workspaceId, userId },
          "User already member of workspace, skipping"
        );
        return {
          id: pendingInvite.workspaceId,
          role: existingMember.role as "admin" | "owner" | "editor" | "viewer",
        };
      }

      // Add user to workspace with role from invite
      await db.insert(workspaceMembers).values({
        workspaceId: pendingInvite.workspaceId,
        userId,
        role: pendingInvite.role,
        invitedBy: pendingInvite.invitedBy,
      });

      // Delete the invite (it's been used)
      await db.delete(invites).where(eq(invites.id, pendingInvite.id));

      logger.info(
        {
          workspaceId: pendingInvite.workspaceId,
          userId,
          role: pendingInvite.role,
        },
        "User joined workspace via invite"
      );

      return {
        id: pendingInvite.workspaceId,
        role: pendingInvite.role as "admin" | "owner" | "editor" | "viewer",
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
