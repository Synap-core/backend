/**
 * UserProvisioningService — transactional Kratos + users + workspace seeding.
 *
 * Replaces the broken /api/provision/setup-account flow, where Kratos only
 * fires `identity.created` webhooks for self-service flows, not admin-API
 * creates — so the users table stayed empty after admin provisioning.
 *
 * This module does the full stack in one pass, inside a DB transaction:
 *   1. Find-or-create Kratos identity (via admin API).
 *   2. Upsert the users row with id = kratosIdentityId.
 *   3. If the user has no workspace, create a default personal workspace
 *      + owner membership.
 *
 * Idempotent — safe to call multiple times with the same email.
 */
import { eq } from "drizzle-orm";
import { createLogger } from "@synap-core/core";
import { db } from "../client-pg.js";
import { users } from "../schema/users.js";
import { workspaces, workspaceMembers } from "../schema/workspaces.js";

const logger = createLogger({ module: "user-provisioning" });

const normalizeEmail = (e: string) => e.trim().toLowerCase();

export interface SeedAdminUserInput {
  email: string;
  name?: string;
  /** Random password assigned to a freshly-created Kratos identity. */
  randomPassword: string;
  /** Base URL of the Kratos admin API (e.g. http://localhost:4434). */
  kratosAdminUrl: string;
}

export interface SeedAdminUserResult {
  userId: string;
  workspaceId: string;
  kratosIdentityId: string;
  /** True if the Kratos identity already existed prior to this call. */
  alreadyExisted: boolean;
}

/**
 * Atomically provision an admin user on this pod.
 *
 * Flow:
 *   - Lookup Kratos identity by email. If missing, create it via the Kratos
 *     admin API with the supplied random password, verified email, and
 *     metadata_public: { createdVia: "provision-seed", setupRequired: false }.
 *   - Upsert users row keyed on the Kratos identity id.
 *   - Ensure the user owns at least one personal workspace with an
 *     owner-role membership.
 *
 * DB writes run inside a single transaction. Kratos calls happen before the
 * transaction (they cannot be rolled back), but the resulting identity id is
 * the primary key used inside the transaction — so if the DB writes fail,
 * the next retry will pick up the existing Kratos identity via the lookup.
 */
export async function seedAdminUser(
  input: SeedAdminUserInput
): Promise<SeedAdminUserResult> {
  const email = normalizeEmail(input.email);
  if (!email) {
    throw new Error("seedAdminUser: email is required");
  }
  const name = input.name?.trim() || undefined;
  const { kratosAdminUrl } = input;

  // ─── 1. Find or create Kratos identity ──────────────────────────────────
  let kratosIdentityId: string | null = null;
  let alreadyExisted = false;

  try {
    const listResp = await fetch(
      `${kratosAdminUrl}/admin/identities?credentials_identifier=${encodeURIComponent(email)}`
    );
    if (listResp.ok) {
      const identities = (await listResp.json()) as Array<{ id: string }>;
      if (Array.isArray(identities) && identities.length > 0) {
        kratosIdentityId = identities[0].id;
        alreadyExisted = true;
      }
    }
  } catch (err) {
    logger.warn(
      { err, email },
      "seedAdminUser: Kratos identity lookup failed — will attempt create"
    );
  }

  if (!kratosIdentityId) {
    const createResp = await fetch(`${kratosAdminUrl}/admin/identities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema_id: "default",
        traits: { email, ...(name ? { name } : {}) },
        credentials: {
          password: { config: { password: input.randomPassword } },
        },
        metadata_public: {
          createdVia: "provision-seed",
          setupRequired: false,
          seededAt: new Date().toISOString(),
        },
        verifiable_addresses: [
          {
            value: email,
            verified: true,
            via: "email",
            status: "completed",
          },
        ],
      }),
    });
    if (!createResp.ok) {
      const errBody = await createResp.text().catch(() => "");
      throw new Error(
        `seedAdminUser: failed to create Kratos identity (status=${createResp.status}, body=${errBody.slice(0, 500)})`
      );
    }
    const newIdentity = (await createResp.json()) as { id: string };
    kratosIdentityId = newIdentity.id;
    alreadyExisted = false;
    logger.info(
      { email, kratosIdentityId },
      "seedAdminUser: created Kratos identity"
    );
  }

  if (!kratosIdentityId) {
    throw new Error("seedAdminUser: unable to resolve Kratos identity id");
  }

  const identityId = kratosIdentityId;

  // ─── 2–3. Upsert user + ensure workspace membership (transactional) ─────
  const workspaceId = await db.transaction(async (tx) => {
    // Upsert users row. Kratos identity id is the canonical primary key.
    await tx
      .insert(users)
      .values({
        id: identityId,
        email,
        name: name ?? null,
        emailVerified: true,
        userType: "human",
        kratosIdentityId: identityId,
        lastSyncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          email,
          name: name ?? null,
          emailVerified: true,
          userType: "human",
          kratosIdentityId: identityId,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        },
      });

    // If the user already has a workspace membership, reuse it.
    const existingMembership = await tx.query.workspaceMembers.findFirst({
      where: eq(workspaceMembers.userId, identityId),
      columns: { workspaceId: true },
    });
    if (existingMembership) {
      return existingMembership.workspaceId;
    }

    // Otherwise create a default personal workspace + owner membership.
    const workspaceName = `${email.split("@")[0]}'s workspace`;
    const [workspace] = await tx
      .insert(workspaces)
      .values({
        ownerId: identityId,
        name: workspaceName,
        type: "personal",
        settings: {
          createdBy: "provisioning",
          provisionedAt: new Date().toISOString(),
        },
      })
      .returning({ id: workspaces.id });

    if (!workspace) {
      throw new Error("seedAdminUser: failed to create default workspace");
    }

    await tx.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId: identityId,
      role: "owner",
    });

    return workspace.id;
  });

  logger.info(
    { email, userId: identityId, workspaceId, alreadyExisted },
    "seedAdminUser: user seeded"
  );

  return {
    userId: identityId,
    workspaceId,
    kratosIdentityId: identityId,
    alreadyExisted,
  };
}
