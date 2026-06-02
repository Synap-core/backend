/**
 * Create first admin user (Kratos identity + DB user, optional default workspace).
 * Used by install CLI (bundled) and local `pnpm tsx scripts/create-admin-cli.ts`.
 */

import { kratosAdmin } from "@synap/auth";
import { getDb } from "@synap/database";
import { and, eq } from "drizzle-orm";
import { users, workspaces, workspaceMembers } from "@synap/database/schema";

/**
 * Seed the system "pod-admin" workspace if it doesn't exist, then ensure
 * the given user is an owner of it. The pod-admin workspace is the gate
 * for `podAdminProcedure` (system.*, sync.getStatus, audit.*, etc.) — without
 * membership, the operator can sign in but every admin tRPC call returns
 * 403 "Pod admin access required".
 */
async function ensurePodAdminWorkspace(
  identityId: string,
  db: Awaited<ReturnType<typeof getDb>>
): Promise<string> {
  const existing = await db.query.workspaces.findFirst({
    where: eq(workspaces.systemSlug, 'pod-admin'),
    columns: { id: true },
  });

  let podAdminId: string;
  if (existing) {
    podAdminId = existing.id;
  } else {
    const [created] = await db
      .insert(workspaces)
      .values({
        ownerId: identityId,
        name: "Pod Admin",
        type: "personal",
        systemSlug: "pod-admin",
        settings: { systemSlug: "pod-admin" },
      })
      .returning({ id: workspaces.id });
    if (!created) throw new Error("Failed to create pod-admin workspace");
    podAdminId = created.id;
    console.error(
      `[create-admin] Created pod-admin system workspace ${podAdminId}`
    );
  }

  // Ensure the operator is an owner — first-admin always gets owner; later
  // admins are added by an existing pod admin via the operator console.
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, podAdminId),
      eq(workspaceMembers.userId, identityId)
    ),
    columns: { role: true },
  });
  if (!membership) {
    await db.insert(workspaceMembers).values({
      workspaceId: podAdminId,
      userId: identityId,
      role: "owner",
    });
    console.error(`[create-admin] Granted ${identityId} pod-admin owner`);
  }

  return podAdminId;
}

/**
 * Create or repair a pod admin. Idempotent — every step is "ensure", not
 * "create-or-throw". Safe to run repeatedly against any partial state:
 *
 *   • Kratos identity missing  → create it.
 *   • Kratos identity present  → look it up, optionally rotate password.
 *   • `users` row missing      → backfill from the identity.
 *   • pod-admin workspace      → ensure exists, ensure owner membership.
 *   • personal workspace       → ensure exists if `createWorkspace`.
 *
 * The previous implementation threw on Kratos 409 (identity exists) or on
 * `users` PK violation (row exists), leaving the operator permanently
 * locked out whenever any one piece had been wiped while others survived.
 * Self-heal is the rule now: every invocation either ends in a healthy
 * pod-admin invariant or reports specifically what failed.
 */
export async function createAdminUser(
  email: string,
  password: string,
  name?: string,
  options?: { createWorkspace?: boolean; resetPassword?: boolean }
): Promise<{ identityId: string; userId: string; workspaceId: string | null }> {
  const createWorkspace = options?.createWorkspace ?? true;
  const resetPassword = options?.resetPassword ?? false;
  const db = await getDb();
  const normalizedEmail = email.trim().toLowerCase();

  try {
    console.error(
      `[create-admin] Ensuring pod admin for ${normalizedEmail} (idempotent)`
    );

    // Step 1: Kratos identity. Try to create; if 409, look up existing.
    let identityId: string;
    try {
      const { data: identity } = await kratosAdmin.createIdentity({
        createIdentityBody: {
          schema_id: "default",
          traits: {
            email: normalizedEmail,
            name: name || normalizedEmail.split("@")[0],
          },
          credentials: {
            password: { config: { password } },
          },
          verifiable_addresses: [
            {
              value: normalizedEmail,
              verified: true,
              via: "email",
              status: "completed",
            },
          ],
        },
      });
      identityId = identity.id;
      console.error(`[create-admin] Created Kratos identity ${identityId}`);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if (status !== 409) throw err;
      const existing = await findKratosIdentityByEmail(normalizedEmail);
      if (!existing) {
        throw new Error(
          `Kratos rejected createIdentity with 409 but no identity matching ${normalizedEmail} could be found. Manual intervention required.`
        );
      }
      identityId = existing.id;
      console.error(
        `[create-admin] Reusing existing Kratos identity ${identityId}`
      );
      if (resetPassword) {
        await rotateKratosPassword(identityId, password);
      }
    }

    // Step 2: `users` row. Backfill if missing — never throw on PK collision.
    await ensureUserRow(identityId, normalizedEmail, name);

    // Step 3: pod-admin system workspace + owner membership.
    await ensurePodAdminWorkspace(identityId, db);

    // Step 4: personal workspace (optional, only when requested).
    let personalWorkspaceId: string | null = null;
    if (createWorkspace) {
      personalWorkspaceId = await ensureWorkspaceForUser(identityId, name);
    }

    return {
      identityId,
      userId: identityId,
      workspaceId: personalWorkspaceId,
    };
  } catch (error: unknown) {
    console.error(`[create-admin] Failed for ${normalizedEmail}:`, error);
    const err = error as { response?: { data?: unknown } };
    if (err.response?.data) {
      console.error("[create-admin] Kratos API error:", err.response.data);
    }
    throw error;
  }
}

/**
 * Rotate a Kratos identity's password. Used by `createAdminUser` when called
 * with `resetPassword: true` — gives operators a way to recover access when
 * the admin email is known but the password was lost.
 */
async function rotateKratosPassword(
  identityId: string,
  password: string
): Promise<void> {
  const client = kratosAdmin as unknown as {
    updateIdentity: (args: {
      id: string;
      updateIdentityBody: Record<string, unknown>;
    }) => Promise<{ data: { id: string } }>;
    getIdentity: (args: { id: string }) => Promise<{
      data: {
        id: string;
        schema_id: string;
        traits?: Record<string, unknown>;
        state?: string;
        verifiable_addresses?: unknown;
      };
    }>;
  };
  const { data: current } = await client.getIdentity({ id: identityId });
  await client.updateIdentity({
    id: identityId,
    updateIdentityBody: {
      schema_id: current.schema_id,
      state: current.state ?? "active",
      traits: current.traits ?? {},
      credentials: { password: { config: { password } } },
    },
  });
  console.error(`[create-admin] Rotated password for ${identityId}`);
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
