/**
 * Create first admin user (Kratos identity + DB user + default workspace).
 * Used by install CLI (bundled) and local `pnpm tsx scripts/create-admin-cli.ts`.
 */

import { kratosAdmin } from "@synap/auth";
import { getDb } from "@synap/database";
import { users, workspaces, workspaceMembers } from "@synap/database/schema";

export async function createAdminUser(
  email: string,
  password: string,
  name?: string
): Promise<{ identityId: string; userId: string; workspaceId: string }> {
  const db = await getDb();

  try {
    console.error(`[create-admin] Starting admin user creation for ${email}`);

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
              password,
            },
          },
        },
        verifiable_addresses: [
          {
            value: email,
            verified: true,
            via: "email",
            status: "completed",
          },
        ],
      },
    });

    const identityId = identity.id;
    console.error(`[create-admin] Created Kratos identity ${identityId}`);

    await db.insert(users).values({
      id: identityId,
      email,
      name: name || null,
      emailVerified: true,
      kratosIdentityId: identityId,
      lastSyncedAt: new Date(),
    });

    console.error(`[create-admin] Created user in backend DB ${identityId}`);

    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: identityId,
        name: name ? `${name}'s Workspace` : "My Workspace",
        type: "personal",
        settings: {},
      })
      .returning();

    console.error(`[create-admin] Created default workspace ${workspace.id}`);

    await db.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId: identityId,
      role: "admin",
    });

    console.error(
      `[create-admin] Added user as admin on workspace ${workspace.id}`
    );

    return {
      identityId,
      userId: identityId,
      workspaceId: workspace.id,
    };
  } catch (error: unknown) {
    console.error(`[create-admin] Failed for ${email}:`, error);
    const err = error as { response?: { data?: unknown } };
    if (err.response?.data) {
      console.error("[create-admin] Kratos API error:", err.response.data);
    }
    throw error;
  }
}
