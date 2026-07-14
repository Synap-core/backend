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
import { projects } from "../schema/projects.js";
import { projectMembers } from "../schema/project-members.js";
import { controlPlaneMemberActivations } from "../schema/control-plane-member-activations.js";

const logger = createLogger({ module: "user-provisioning" });

const normalizeEmail = (e: string) => e.trim().toLowerCase();

export interface SeedAdminUserInput {
  /** Kratos identity id, pre-resolved by the caller (find-or-create via Kratos admin API). */
  kratosIdentityId: string;
  /** Stable CP account id. Required by managed provisioning; absent in local mode. */
  controlPlaneUserId?: string;
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

interface ActivateControlPlaneMemberBaseInput {
  /** CP-generated idempotency key for this accepted invite. */
  activationId: string;
  /** Stable CP account id. It is never inferred from an email address. */
  controlPlaneUserId: string;
  /** Pod-local Kratos identity id, resolved by the HTTP layer. */
  kratosIdentityId: string;
  email: string;
  name?: string;
  role: "admin" | "editor" | "viewer";
}

export type ActivateControlPlaneMemberInput =
  | (ActivateControlPlaneMemberBaseInput & {
      scopeKind: "workspace";
      workspaceId: string;
      projectId?: never;
    })
  | (ActivateControlPlaneMemberBaseInput & {
      scopeKind: "project";
      projectId: string;
      workspaceId?: never;
    });

export interface ActivateControlPlaneMemberResult {
  userId: string;
  scopeKind: "workspace" | "project";
  workspaceId: string | null;
  projectId: string | null;
  role: "admin" | "editor" | "viewer";
  alreadyActivated: boolean;
  membershipCreated: boolean;
}

export type BindExistingControlPlaneUserResult =
  | {
      status: "bound";
      userId: string;
      workspaceId: string | null;
      projectId: string | null;
    }
  | {
      status: "not-active";
      reason:
        | "identity-not-projected"
        | "access-not-found"
        | "control-plane-user-conflict"
        | "pod-user-conflict";
    };

/**
 * Explicitly bind a CP identity to a user authenticated directly on this Pod.
 *
 * This is the safe bridge for "add an existing Pod by URL": the direct Pod
 * session proves the user already has access, while the CP becomes the issuer
 * for later sessions. This mutating primitive must only be called from an
 * endpoint protected by a direct Pod session and a validated CP bind assertion.
 * It deliberately cannot create users, workspaces, projects, or memberships.
 */
export async function bindExistingControlPlaneUser(input: {
  controlPlaneUserId: string;
  kratosIdentityId: string;
}): Promise<BindExistingControlPlaneUserResult> {
  const controlPlaneUserId = input.controlPlaneUserId.trim();
  const identityId = input.kratosIdentityId.trim();
  if (!controlPlaneUserId || !identityId) {
    return { status: "not-active", reason: "identity-not-projected" };
  }

  return db.transaction(async (tx) => {
    const [podUser, mappedUser, workspaceMembership, projectMembership] =
      await Promise.all([
        tx.query.users.findFirst({
          where: eq(users.id, identityId),
          columns: { id: true, controlPlaneUserId: true },
        }),
        tx.query.users.findFirst({
          where: eq(users.controlPlaneUserId, controlPlaneUserId),
          columns: { id: true },
        }),
        tx.query.workspaceMembers.findFirst({
          where: eq(workspaceMembers.userId, identityId),
          columns: { workspaceId: true },
        }),
        tx.query.projectMembers.findFirst({
          where: eq(projectMembers.userId, identityId),
          columns: { projectId: true },
        }),
      ]);

    if (!podUser) {
      return {
        status: "not-active",
        reason: "identity-not-projected",
      } as const;
    }
    if (!workspaceMembership && !projectMembership) {
      return { status: "not-active", reason: "access-not-found" } as const;
    }
    if (mappedUser && mappedUser.id !== identityId) {
      return {
        status: "not-active",
        reason: "control-plane-user-conflict",
      } as const;
    }
    if (
      podUser.controlPlaneUserId &&
      podUser.controlPlaneUserId !== controlPlaneUserId
    ) {
      return { status: "not-active", reason: "pod-user-conflict" } as const;
    }

    if (!podUser.controlPlaneUserId) {
      await tx
        .update(users)
        .set({
          controlPlaneUserId,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(users.id, identityId));
    }

    return {
      status: "bound",
      userId: identityId,
      workspaceId: workspaceMembership?.workspaceId ?? null,
      projectId: projectMembership?.projectId ?? null,
    } as const;
  });
}

/**
 * Project a Control Plane invitation into one exact Pod scope.
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
  const workspaceId =
    input.scopeKind === "workspace" ? input.workspaceId.trim() : null;
  const projectId =
    input.scopeKind === "project" ? input.projectId.trim() : null;
  const email = normalizeEmail(input.email);
  const name = input.name?.trim() || null;

  if (
    !activationId ||
    !controlPlaneUserId ||
    !identityId ||
    (input.scopeKind === "workspace" ? !workspaceId : !projectId) ||
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
        receipt.scopeKind === input.scopeKind &&
        receipt.workspaceId === workspaceId &&
        receipt.projectId === projectId &&
        receipt.role === input.role;
      if (!matches) {
        throw new Error(
          "activateControlPlaneMember: activationId was already used for a different grant"
        );
      }
      return {
        userId: identityId,
        scopeKind: input.scopeKind,
        workspaceId,
        projectId,
        role: input.role,
        alreadyActivated: true,
        membershipCreated: false,
      } as const;
    }

    const [mappedUser, identityUser, emailUser, workspace, project] =
      await Promise.all([
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
        workspaceId
          ? tx.query.workspaces.findFirst({
              where: eq(workspaces.id, workspaceId),
              columns: { id: true, systemSlug: true, archivedAt: true },
            })
          : Promise.resolve(undefined),
        projectId
          ? tx.query.projects.findFirst({
              where: eq(projects.id, projectId),
              columns: { id: true, workspaceId: true, status: true },
            })
          : Promise.resolve(undefined),
      ]);

    if (workspaceId && !workspace) {
      throw new Error(
        "activateControlPlaneMember: requested workspace does not exist"
      );
    }
    if (workspace?.archivedAt || workspace?.systemSlug) {
      throw new Error(
        "activateControlPlaneMember: requested workspace cannot accept external members"
      );
    }
    if (projectId && (!project || project.status !== "active")) {
      throw new Error(
        "activateControlPlaneMember: requested project is not active"
      );
    }
    if (project?.workspaceId) {
      const parentWorkspace = await tx.query.workspaces.findFirst({
        where: eq(workspaces.id, project.workspaceId),
        columns: { systemSlug: true, archivedAt: true },
      });
      if (
        !parentWorkspace ||
        parentWorkspace.archivedAt ||
        parentWorkspace.systemSlug
      ) {
        throw new Error(
          "activateControlPlaneMember: project belongs to an unavailable workspace"
        );
      }
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

    const existingMembership = workspaceId
      ? await tx.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.userId, identityId),
            eq(workspaceMembers.workspaceId, workspaceId)
          ),
          columns: { id: true, role: true },
        })
      : await tx.query.projectMembers.findFirst({
          where: and(
            eq(projectMembers.userId, identityId),
            eq(projectMembers.projectId, projectId!)
          ),
          columns: { id: true, role: true },
        });
    const membershipCreated = !existingMembership;
    if (!existingMembership) {
      if (workspaceId) {
        await tx.insert(workspaceMembers).values({
          workspaceId,
          userId: identityId,
          role: input.role,
        });
      } else {
        await tx.insert(projectMembers).values({
          projectId: projectId!,
          userId: identityId,
          role: input.role,
        });
      }
    } else if (existingMembership.role !== input.role) {
      throw new Error(
        "activateControlPlaneMember: existing Pod role differs from the requested grant"
      );
    }

    await tx.insert(controlPlaneMemberActivations).values({
      activationId,
      controlPlaneUserId,
      userId: identityId,
      scopeKind: input.scopeKind,
      workspaceId,
      projectId,
      role: input.role,
    });

    return {
      userId: identityId,
      scopeKind: input.scopeKind,
      workspaceId,
      projectId,
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
      scopeKind: result.scopeKind,
      workspaceId,
      projectId,
      alreadyActivated: result.alreadyActivated,
    },
    "activateControlPlaneMember: member projected into requested scope"
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
  const controlPlaneUserId = input.controlPlaneUserId?.trim() || null;
  const name = input.name?.trim() || undefined;
  const emailVerified = input.emailVerified ?? true;

  const { workspaceId, alreadyExisted } = await db.transaction(async (tx) => {
    // Detect pre-existing users row for accurate alreadyExisted reporting.
    const [existingUser, mappedUser] = await Promise.all([
      tx.query.users.findFirst({
        where: eq(users.id, identityId),
        columns: { id: true, controlPlaneUserId: true },
      }),
      controlPlaneUserId
        ? tx.query.users.findFirst({
            where: eq(users.controlPlaneUserId, controlPlaneUserId),
            columns: { id: true },
          })
        : Promise.resolve(undefined),
    ]);
    if (mappedUser && mappedUser.id !== identityId) {
      throw new Error(
        "seedAdminUser: Control Plane account is already mapped to another Pod identity"
      );
    }
    if (
      existingUser?.controlPlaneUserId &&
      controlPlaneUserId &&
      existingUser.controlPlaneUserId !== controlPlaneUserId
    ) {
      throw new Error(
        "seedAdminUser: Pod identity is already mapped to another Control Plane account"
      );
    }

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
        ...(controlPlaneUserId ? { controlPlaneUserId } : {}),
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
          ...(controlPlaneUserId ? { controlPlaneUserId } : {}),
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
