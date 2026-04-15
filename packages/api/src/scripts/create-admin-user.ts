/**
 * Create first admin user (Kratos identity + DB user, optional default workspace).
 * Used by install CLI (bundled) and local `pnpm tsx scripts/create-admin-cli.ts`.
 */

import { kratosAdmin } from "@synap/auth";
import { getDb } from "@synap/database";
import { and, eq } from "drizzle-orm";
import { users, workspaces, workspaceMembers } from "@synap/database/schema";

export async function createAdminUser(
  email: string,
  password: string,
  name?: string,
  options?: { createWorkspace?: boolean }
): Promise<{ identityId: string; userId: string; workspaceId: string | null }> {
  const createWorkspace = options?.createWorkspace ?? true;
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

    if (!createWorkspace) {
      console.error(
        "[create-admin] Skipping default workspace creation by option"
      );
      return {
        identityId,
        userId: identityId,
        workspaceId: null,
      };
    }

    // Reuse existing membership/workspace if present.
    const existingMembership = await db.query.workspaceMembers.findFirst({
      where: eq(workspaceMembers.userId, identityId),
    });
    if (existingMembership) {
      console.error(
        `[create-admin] Existing workspace membership found: ${existingMembership.workspaceId}`
      );
      return {
        identityId,
        userId: identityId,
        workspaceId: existingMembership.workspaceId,
      };
    }

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

export async function findKratosIdentityByEmail(email: string): Promise<{
  id: string;
  traits?: { email?: string; name?: string };
  schema_id: string;
  state?: string;
} | null> {
  const normalized = email.trim().toLowerCase();
  const client = kratosAdmin as unknown as {
    listIdentities: (args: Record<string, unknown>) => Promise<{
      data: Array<{
        id: string;
        traits?: { email?: string; name?: string };
        schema_id: string;
        state?: string;
      }>;
    }>;
  };

  // Fast path if Kratos supports credentialsIdentifier filter.
  try {
    const { data } = await client.listIdentities({
      credentialsIdentifier: normalized,
      pageSize: 50,
      pageToken: "",
    });
    const exact = data.find(
      (identity) => identity.traits?.email?.toLowerCase() === normalized
    );
    if (exact) return exact;
  } catch {
    // Fall back to broad list scan below.
  }

  try {
    const { data } = await client.listIdentities({
      pageSize: 500,
      pageToken: "",
    });
    return (
      data.find(
        (identity) => identity.traits?.email?.toLowerCase() === normalized
      ) ?? null
    );
  } catch (error) {
    console.error("[create-admin] Failed to lookup identity by email:", error);
    return null;
  }
}

export async function ensureUserRow(
  identityId: string,
  email: string,
  name?: string
): Promise<void> {
  const db = await getDb();
  const existing = await db.query.users.findFirst({
    where: eq(users.id, identityId),
    columns: { id: true },
  });
  if (existing) return;

  await db.insert(users).values({
    id: identityId,
    email,
    name: name || null,
    emailVerified: true,
    kratosIdentityId: identityId,
    lastSyncedAt: new Date(),
  });
  console.error(
    `[create-admin] Backfilled missing users row for ${identityId}`
  );
}

export async function ensureWorkspaceForUser(
  identityId: string,
  name?: string
): Promise<string> {
  const db = await getDb();
  const existingMembership = await db.query.workspaceMembers.findFirst({
    where: eq(workspaceMembers.userId, identityId),
    columns: { workspaceId: true },
  });
  if (existingMembership) return existingMembership.workspaceId;

  const [workspace] = await db
    .insert(workspaces)
    .values({
      ownerId: identityId,
      name: name ? `${name}'s Workspace` : "My Workspace",
      type: "personal",
      settings: {},
    })
    .returning();

  const alreadyLinked = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspace.id),
      eq(workspaceMembers.userId, identityId)
    ),
    columns: { workspaceId: true },
  });
  if (!alreadyLinked) {
    await db.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId: identityId,
      role: "admin",
    });
  }

  return workspace.id;
}
