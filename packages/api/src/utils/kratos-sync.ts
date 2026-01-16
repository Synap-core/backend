/**
 * Kratos Webhook Utilities
 *
 * Syncs Kratos identities to Synap database and creates default workspaces
 */

import { kratosAdmin } from "@synap/auth";
import { getDb } from "@synap/database";
import { users, workspaces, workspaceMembers } from "@synap/database/schema";
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
 */
export async function createDefaultWorkspace(
  userId: string,
  traits: { name?: string; email: string }
): Promise<void> {
  const db = await getDb();

  try {
    // Create default workspace
    // Note: If webhook fires twice, user gets 2 workspaces - acceptable for MVP
    // TODO: Add proper deduplication check once pnpm phantom deps are resolved
    const workspaceName = traits.name
      ? `${traits.name}'s Workspace`
      : "My Workspace";

    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: userId,
        name: workspaceName,
        type: "personal",
        settings: {},
      })
      .returning();

    logger.info(
      { workspaceId: workspace.id, userId },
      "Created default workspace"
    );

    // Add user as workspace owner
    await db.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId,
      role: "owner",
    });

    logger.info(
      { workspaceId: workspace.id, userId },
      "Added user as workspace owner"
    );
  } catch (error) {
    logger.error({ err: error, userId }, "Failed to create default workspace");
    throw error;
  }
}
