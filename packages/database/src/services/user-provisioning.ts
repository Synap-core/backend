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
import { controlPlaneMemberActivations } from "../schema/control-plane-member-activations.js";

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

export interface ActivateControlPlaneMemberInput {
  /** CP-generated idempotency key for this accepted invite. */
  activationId: string;
  /** Stable CP account id. It is never inferred from an email address. */
  controlPlaneUserId: string;
  /** Pod-local Kratos identity id, resolved by the HTTP layer. */
  kratosIdentityId: string;
  email: string;
  name?: string;
  workspaceId: string;
  role: "admin" | "editor" | "viewer";
}

export interface ActivateControlPlaneMemberResult {
  userId: string;
  workspaceId: string;
  role: "admin" | "editor" | "viewer";
  alreadyActivated: boolean;
  membershipCreated: boolean;
}

/**
 * Project a Control Plane invitation into one Pod workspace.
 *
 * This intentionally does not call `seedAdminUser`: invited members must not
 * receive a personal workspace, an owner role, or a personal agent. The
 * Control Plane owns lifecycle/orchestration; the Pod only applies this signed
 * command atomically and records its receipt for retry safety.
 */
export async function activateControlPlaneMember(
  input: ActivateControlPlaneMemberInput
): Promise<ActivateControlPlaneMemberResult> {
  const activationId = input.activationId.trim();
  const controlPlaneUserId = input.controlPlaneUserId.trim();
  const identityId = input.kratosIdentityId.trim();
  const workspaceId = input.workspaceId.trim();
  const email = normalizeEmail(input.email);
  const name = input.name?.trim() || null;

  if (
    !activationId ||
    !controlPlaneUserId ||
    !identityId ||
    !workspaceId ||
    !email
  ) {
    throw new Error(
      "activateControlPlaneMember: required activation claims are missing"
    );
  }

  const result = await db.transaction(async (tx) => {
    const receipt = await tx.query.controlPlaneMemberActivations.findFirst({
      where: eq(controlPlaneMemberActivations.activationId, activationId),
    });
    if (receipt) {
      const matches =
        receipt.controlPlaneUserId === controlPlaneUserId &&
        receipt.userId === identityId &&
        receipt.workspaceId === workspaceId &&
        receipt.role === input.role;
      if (!matches) {
        throw new Error(
          "activateControlPlaneMember: activationId was already used for a different grant"
        );
      }
      return {
        userId: identityId,
        workspaceId,
        role: input.role,
        alreadyActivated: true,
        membershipCreated: false,
      } as const;
    }

    const [mappedUser, identityUser, emailUser, workspace] = await Promise.all([
      tx.query.users.findFirst({
        where: eq(users.controlPlaneUserId, controlPlaneUserId),
        columns: { id: true },
      }),
      tx.query.users.findFirst({
        where: eq(users.id, identityId),
        columns: { id: true, controlPlaneUserId: true },
      }),
      tx.query.users.findFirst({
        where: eq(users.email, email),
        columns: { id: true },
      }),
      tx.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
        columns: { id: true },
      }),
    ]);

    if (!workspace) {
      throw new Error(
        "activateControlPlaneMember: requested workspace does not exist"
      );
    }
    if (mappedUser && mappedUser.id !== identityId) {
      throw new Error(
        "activateControlPlaneMember: Control Plane account is already mapped to another Pod identity"
      );
    }
    if (
      identityUser?.controlPlaneUserId &&
      identityUser.controlPlaneUserId !== controlPlaneUserId
    ) {
      throw new Error(
        "activateControlPlaneMember: Pod identity is already mapped to another Control Plane account"
      );
    }
    if (emailUser && emailUser.id !== identityId) {
      throw new Error(
        "activateControlPlaneMember: email is already mapped to another Pod identity"
      );
    }

    await tx
      .insert(users)
      .values({
        id: identityId,
        email,
        name,
        emailVerified: true,
        userType: "human",
        kratosIdentityId: identityId,
        controlPlaneUserId,
        lastSyncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          email,
          name,
          emailVerified: true,
          userType: "human",
          kratosIdentityId: identityId,
          controlPlaneUserId,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        },
      });

    const existingMembership = await tx.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.userId, identityId),
        eq(workspaceMembers.workspaceId, workspaceId)
      ),
      columns: { id: true, role: true },
    });
    const membershipCreated = !existingMembership;
    if (!existingMembership) {
      await tx.insert(workspaceMembers).values({
        workspaceId,
        userId: identityId,
        role: input.role,
      });
    } else if (
      existingMembership.role !== "owner" &&
      existingMembership.role !== input.role
    ) {
      // CP is authoritative for invited-member roles, but a pre-existing owner
      // can never be silently demoted by an invite retry.
      await tx
        .update(workspaceMembers)
        .set({ role: input.role })
        .where(eq(workspaceMembers.id, existingMembership.id));
    }

    await tx.insert(controlPlaneMemberActivations).values({
      activationId,
      controlPlaneUserId,
      userId: identityId,
      workspaceId,
      role: input.role,
    });

    return {
      userId: identityId,
      workspaceId,
      role: input.role,
      alreadyActivated: false,
      membershipCreated,
    } as const;
  });

  logger.info(
    {
      activationId,
      controlPlaneUserId,
      userId: result.userId,
      workspaceId,
      alreadyActivated: result.alreadyActivated,
    },
    "activateControlPlaneMember: member projected into requested workspace"
  );
  return result;
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
