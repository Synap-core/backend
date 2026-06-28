/**
 * UserProvisioningService — transactional users + workspace seeding.
 *
 * Replaces the broken /api/provision/setup-account flow, where Kratos only
 * fires `identity.created` webhooks for self-service flows, not admin-API
 * creates — so the users table stayed empty after admin provisioning.
 *
 * This module does the DB side of the admin seed in one pass, inside a
 * transaction:
 *   1. Upsert the users row with id = kratosIdentityId.
 *   2. If the user has no workspace, create a default personal workspace
 *      + owner membership.
 *
 * The Kratos admin API call (find-or-create identity) is the CALLER's
 * responsibility — this keeps `@synap/database` free of HTTP concerns.
 * See `apps/api/src/routers/provision.ts` for the seed-admin handler that
 * resolves the identity id and then invokes this service.
 *
 * Idempotent — safe to call multiple times with the same Kratos identity id.
 */
import { eq, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";
import { db } from "../client-pg.js";
import { users } from "../schema/users.js";
import { workspaces, workspaceMembers } from "../schema/workspaces.js";

const logger = createLogger({ module: "user-provisioning" });

const normalizeEmail = (e: string) => e.trim().toLowerCase();

export interface SeedAdminUserInput {
  /** Kratos identity id, pre-resolved by the caller (find-or-create via Kratos admin API). */
  kratosIdentityId: string;
  email: string;
  name?: string;
  /** Whether the Kratos identity reports the email as verified. */
  emailVerified?: boolean;
}

export interface SeedAdminUserResult {
  userId: string;
  workspaceId: string;
  /** True if the `users` row pre-existed prior to this call. */
  alreadyExisted: boolean;
}

/**
 * Atomically seed a users row + default workspace on this pod, keyed on a
 * pre-resolved Kratos identity id.
 *
 * Flow (all in a single DB transaction):
 *   - Detect whether a `users` row already exists for the identity id.
 *   - Upsert the users row (email/name/verified refreshed on conflict).
 *   - Ensure the user owns at least one personal workspace with an
 *     owner-role membership; reuse the first existing membership if any.
 *
 * `alreadyExisted` reflects whether the USERS row pre-existed — the caller
 * is responsible for reporting Kratos-identity existence if needed.
 */
export async function seedAdminUser(
  input: SeedAdminUserInput
): Promise<SeedAdminUserResult> {
  const email = normalizeEmail(input.email);
  if (!email) {
    throw new Error("seedAdminUser: email is required");
  }
  const identityId = input.kratosIdentityId?.trim();
  if (!identityId) {
    throw new Error("seedAdminUser: kratosIdentityId is required");
  }
  const name = input.name?.trim() || undefined;
  const emailVerified = input.emailVerified ?? true;

  const { workspaceId, alreadyExisted } = await db.transaction(async (tx) => {
    // Detect pre-existing users row for accurate alreadyExisted reporting.
    const existingUser = await tx.query.users.findFirst({
      where: eq(users.id, identityId),
      columns: { id: true },
    });

    // Upsert users row. Kratos identity id is the canonical primary key.
    await tx
      .insert(users)
      .values({
        id: identityId,
        email,
        name: name ?? null,
        emailVerified,
        userType: "human",
        kratosIdentityId: identityId,
        lastSyncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          email,
          name: name ?? null,
          emailVerified,
          userType: "human",
          kratosIdentityId: identityId,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        },
      });

    // If the user already has a user-visible workspace membership, reuse it.
    // Internal/system memberships such as pod-admin are not enough for the
    // Browser: it intentionally filters them out, so treating one as the
    // default workspace leaves the user authenticated with an empty space list.
    const existingMembership = await tx.query.workspaceMembers.findFirst({
      where: eq(workspaceMembers.userId, identityId),
      columns: { workspaceId: true },
      with: {
        workspace: {
          columns: { settings: true },
        },
      },
    });
    const existingSystemSlug =
      existingMembership?.workspace?.settings &&
      typeof existingMembership.workspace.settings === "object"
        ? (existingMembership.workspace.settings as Record<string, unknown>)
            .systemSlug
        : null;
    if (existingMembership && existingSystemSlug !== "pod-admin") {
      return {
        workspaceId: existingMembership.workspaceId,
        alreadyExisted: !!existingUser,
      };
    }

    // Otherwise create a default personal workspace + owner membership.
    const workspaceName = `${email.split("@")[0]}'s workspace`;
    const [workspace] = await tx
      .insert(workspaces)
      .values({
        ownerId: identityId,
        name: workspaceName,
        workspaceType: "personal",
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

    // Idempotency guard: only create a twin if none exists for this user
    const existingTwin = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.userType, "agent"),
          eq(users.createdByUserId, identityId),
          eq(users.agentTemplate, "twin")
        )
      )
      .limit(1);

    if (existingTwin.length === 0) {
      const twinId = randomUUID();
      const twinShortId = twinId.slice(0, 8);
      await tx.insert(users).values({
        id: twinId,
        email: `agent-twin-${twinShortId}@synap.agent`,
        emailVerified: true,
        userType: "agent",
        agentTemplate: "twin",
        agentType: "twin",
        createdByUserId: identityId,
        isPersonalAgent: false,
        agentMetadata: {
          agentTemplate: "twin",
          agentType: "twin",
          createdByUserId: identityId,
          writesRequireProposal: false,
          isPersonalAgent: false,
        },
        timezone: "UTC",
        locale: "en",
      });

      await tx.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: twinId,
        role: "admin",
      });
    }

    return { workspaceId: workspace.id, alreadyExisted: !!existingUser };
  });

  logger.info(
    { email, userId: identityId, workspaceId, alreadyExisted },
    "seedAdminUser: user seeded"
  );

  return {
    userId: identityId,
    workspaceId,
    alreadyExisted,
  };
}
