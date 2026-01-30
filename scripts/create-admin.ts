/**
 * Create Admin User Script
 *
 * Used during self-hosted installation to create admin user directly
 * Bypasses normal registration flow - creates identity in Kratos and user in backend DB
 */

import "dotenv/config";
import { kratosAdmin } from "@synap/auth";
import { getDb } from "@synap/database";
import { users, workspaces, workspaceMembers } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "create-admin" });

export async function createAdminUser(
  email: string,
  password: string,
  name?: string
): Promise<{ identityId: string; userId: string; workspaceId: string }> {
  const db = await getDb();

  try {
    logger.info({ email }, "Starting admin user creation");

    // 1. Create Kratos identity via Admin API
    const { data: identity } = await kratosAdmin.createIdentity({
      createIdentityBody: {
        schema_id: "default",
        traits: {
          email,
          name: name || email.split("@")[0],
        },
        credentials: {
          password: {
            config: {
              password, // Kratos will hash it automatically
            },
          },
        },
        verifiable_addresses: [
          {
            value: email,
            verified: true, // Self-hosted admin is trusted
            via: "email",
          },
        ],
      },
    });

    const identityId = identity.id;
    logger.info({ identityId, email }, "Created Kratos identity");

    // 2. Create user in backend DB
    await db.insert(users).values({
      id: identityId,
      email,
      name: name || null,
      emailVerified: true, // Self-hosted admin is trusted
      kratosIdentityId: identityId,
      lastSyncedAt: new Date(),
    });

    logger.info({ identityId }, "Created user in backend DB");

    // 3. Create default workspace
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: identityId,
        name: name ? `${name}'s Workspace` : "My Workspace",
        type: "personal",
        settings: {},
      })
      .returning();

    logger.info({ workspaceId: workspace.id }, "Created default workspace");

    // 4. Add user as admin (not just owner)
    await db.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId: identityId,
      role: "admin", // Admin role for backend admin
    });

    logger.info(
      { workspaceId: workspace.id, role: "admin" },
      "Added user as admin"
    );

    return {
      identityId,
      userId: identityId,
      workspaceId: workspace.id,
    };
  } catch (error: any) {
    logger.error({ err: error, email }, "Failed to create admin user");
    if (error.response?.data) {
      logger.error({ kratosError: error.response.data }, "Kratos API error");
    }
    throw error;
  }
}
