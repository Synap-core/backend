/**
 * Pod-local identity and membership provisioning.
 *
 * Federation is intentionally issuer-agnostic: an external subject is never
 * meaningful without the trusted issuer that asserted it.
 */
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { createHash, randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";
import { db } from "../client-pg.js";
import { users } from "../schema/users.js";
import { workspaces, workspaceMembers } from "../schema/workspaces.js";
import { projects } from "../schema/projects.js";
import { projectMembers } from "../schema/project-members.js";
import {
  federatedAccessReceipts,
  federatedIdentityLinks,
  issuerIdentityLinkReceipts,
} from "../schema/federation.js";

const logger = createLogger({ module: "user-provisioning" });
const normalizeEmail = (value: string) => value.trim().toLowerCase();

/**
 * Membership role privilege, most-privileged first. A federated invite must
 * never DOWNGRADE a member who already has broader access (e.g. re-inviting an
 * existing `admin` as `editor` must keep them `admin`), and must be idempotent
 * for an equal or lower re-invite. `owner` can appear on an existing row but is
 * never a grantable invite role, so it always outranks an invite.
 */
const ROLE_RANK: Record<string, number> = {
  owner: 3,
  admin: 2,
  editor: 1,
  viewer: 0,
};
const roleRank = (role: string): number => ROLE_RANK[role] ?? -1;
const hashNonce = (nonce: string) =>
  createHash("sha256").update(nonce).digest("hex");

export type FederatedIdentity = {
  issuerId: string;
  issuerSubject: string;
};

export interface SeedAdminUserInput {
  kratosIdentityId: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
  /** Optional only because a Pod owner may still provision locally. */
  federatedIdentity?: FederatedIdentity;
  /**
   * Atomically claim the first human Pod owner for this issuer-qualified
   * identity. Used only by the install/bootstrap boundary.
   */
  requireUnclaimedPodOwner?: boolean;
}

export interface SeedAdminUserResult {
  userId: string;
  workspaceId: string;
  alreadyExisted: boolean;
}

/** The Pod already has a different human or locally provisioned owner. */
export class PodOwnerAlreadyClaimedError extends Error {
  constructor() {
    super("Pod already has a different human owner");
    this.name = "PodOwnerAlreadyClaimedError";
  }
}

type ExactScope =
  | { scopeKind: "workspace"; workspaceId: string; projectId?: never }
  | { scopeKind: "project"; projectId: string; workspaceId?: never };

export type FederatedAccessTarget = ExactScope;

type FederatedMemberInput = {
  commandId: string;
  issuerId: string;
  issuerSubject: string;
  kratosIdentityId: string;
  email: string;
  name?: string;
  role: "admin" | "editor" | "viewer";
} & ExactScope;

export type ActivateFederatedMemberInput = FederatedMemberInput;

export interface ActivateFederatedMemberResult {
  userId: string;
  scopeKind: "workspace" | "project";
  workspaceId: string | null;
  projectId: string | null;
  role: "admin" | "editor" | "viewer";
  alreadyActivated: boolean;
  membershipCreated: boolean;
}

/**
 * Validate the Pod-owned target of a federation grant before an external auth
 * identity is created. `activateFederatedMember` repeats this validation in
 * its database transaction so a target cannot change between this preflight
 * and the membership write.
 */
export async function assertFederatedAccessTarget(
  input: FederatedAccessTarget
): Promise<void> {
  if (input.scopeKind === "workspace") {
    const workspaceId = input.workspaceId.trim();
    const workspace = workspaceId
      ? await db.query.workspaces.findFirst({
          where: eq(workspaces.id, workspaceId),
          columns: { id: true, systemSlug: true, archivedAt: true },
        })
      : undefined;
    if (!workspace) {
      throw new Error(
        "assertFederatedAccessTarget: requested workspace does not exist"
      );
    }
    if (workspace.archivedAt || workspace.systemSlug) {
      throw new Error(
        "assertFederatedAccessTarget: workspace cannot accept members"
      );
    }
    return;
  }

  const projectId = input.projectId.trim();
  const project = projectId
    ? await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        columns: { id: true, workspaceId: true, status: true },
      })
    : undefined;
  if (!project || project.status !== "active") {
    throw new Error(
      "assertFederatedAccessTarget: requested project is not active"
    );
  }
  if (!project.workspaceId) return;

  const parent = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, project.workspaceId),
    columns: { systemSlug: true, archivedAt: true },
  });
  if (!parent || parent.archivedAt || parent.systemSlug) {
    throw new Error(
      "assertFederatedAccessTarget: project parent is unavailable"
    );
  }
}

export type BindFederatedIdentityResult =
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
        | "issuer-subject-conflict"
        | "issuer-user-conflict";
    };

/**
 * Bind a directly authenticated Pod identity to one external issuer subject.
 * This never creates a user, workspace, project, or membership.
 */
export async function bindExistingFederatedIdentity(input: {
  issuerId: string;
  issuerSubject: string;
  kratosIdentityId: string;
  linkedByUserId?: string;
}): Promise<BindFederatedIdentityResult> {
  const issuerId = input.issuerId.trim();
  const issuerSubject = input.issuerSubject.trim();
  const identityId = input.kratosIdentityId.trim();
  if (!issuerId || !issuerSubject || !identityId) {
    return { status: "not-active", reason: "identity-not-projected" };
  }

  return db.transaction(async (tx) => {
    const [
      podUser,
      subjectLink,
      userLink,
      workspaceMembership,
      projectMembership,
    ] = await Promise.all([
      tx.query.users.findFirst({
        where: eq(users.id, identityId),
        columns: { id: true },
      }),
      tx.query.federatedIdentityLinks.findFirst({
        where: and(
          eq(federatedIdentityLinks.issuerId, issuerId),
          eq(federatedIdentityLinks.issuerSubject, issuerSubject)
        ),
        columns: { userId: true },
      }),
      tx.query.federatedIdentityLinks.findFirst({
        where: and(
          eq(federatedIdentityLinks.issuerId, issuerId),
          eq(federatedIdentityLinks.userId, identityId)
        ),
        columns: { issuerSubject: true },
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
    if (subjectLink && subjectLink.userId !== identityId) {
      return {
        status: "not-active",
        reason: "issuer-subject-conflict",
      } as const;
    }
    if (userLink && userLink.issuerSubject !== issuerSubject) {
      return { status: "not-active", reason: "issuer-user-conflict" } as const;
    }

    if (!subjectLink) {
      await tx.insert(federatedIdentityLinks).values({
        issuerId,
        issuerSubject,
        userId: identityId,
        linkedByUserId: input.linkedByUserId?.trim() || null,
        updatedAt: new Date(),
      });
    }

    return {
      status: "bound",
      userId: identityId,
      workspaceId: workspaceMembership?.workspaceId ?? null,
      projectId: projectMembership?.projectId ?? null,
    } as const;
  });
}

export async function createIssuerIdentityLinkReceipt(input: {
  issuerId: string;
  issuerSubject: string;
  userId: string;
  intentId: string;
  nonce: string;
  expiresAt?: Date;
}): Promise<{ receiptId: string; expiresAt: Date }> {
  const issuerId = input.issuerId.trim();
  const issuerSubject = input.issuerSubject.trim();
  const userId = input.userId.trim();
  const intentId = input.intentId.trim();
  const nonce = input.nonce.trim();
  if (!issuerId || !issuerSubject || !userId || !intentId || !nonce) {
    throw new Error(
      "createIssuerIdentityLinkReceipt: required claims are missing"
    );
  }
  const nonceHash = hashNonce(nonce);
  const expiresAt = input.expiresAt ?? new Date(Date.now() + 5 * 60_000);

  return db.transaction(async (tx) => {
    // A receipt is proof of a binding that exists *now*. Do not issue one from
    // a caller-supplied tuple alone: otherwise a compromised issuer could ask
    // the Pod to attest a subject it has not locally linked.
    const identityLink = await tx.query.federatedIdentityLinks.findFirst({
      where: and(
        eq(federatedIdentityLinks.issuerId, issuerId),
        eq(federatedIdentityLinks.issuerSubject, issuerSubject)
      ),
      columns: { userId: true },
    });
    if (!identityLink || identityLink.userId !== userId) {
      throw new Error(
        "createIssuerIdentityLinkReceipt: federated identity is not linked to this Pod user"
      );
    }

    const existing = await tx.query.issuerIdentityLinkReceipts.findFirst({
      where: and(
        eq(issuerIdentityLinkReceipts.issuerId, issuerId),
        eq(issuerIdentityLinkReceipts.intentId, intentId),
        eq(issuerIdentityLinkReceipts.nonceHash, nonceHash)
      ),
    });
    if (existing) {
      if (
        existing.issuerSubject !== issuerSubject ||
        existing.userId !== userId ||
        existing.consumedAt ||
        existing.expiresAt <= new Date()
      ) {
        throw new Error("identity link intent cannot be replayed");
      }
      return { receiptId: existing.receiptId, expiresAt: existing.expiresAt };
    }

    const receipt = await tx
      .insert(issuerIdentityLinkReceipts)
      .values({
        issuerId,
        issuerSubject,
        userId,
        intentId,
        nonceHash,
        expiresAt,
      })
      .onConflictDoNothing()
      .returning({
        receiptId: issuerIdentityLinkReceipts.receiptId,
        expiresAt: issuerIdentityLinkReceipts.expiresAt,
      })
      .then(([created]) => created);
    if (receipt) return receipt;

    // A concurrent request may have inserted the same issuer-qualified
    // intent. Re-read it and validate every security-relevant field rather
    // than accepting a conflicting receipt as idempotent.
    const concurrent = await tx.query.issuerIdentityLinkReceipts.findFirst({
      where: and(
        eq(issuerIdentityLinkReceipts.issuerId, issuerId),
        eq(issuerIdentityLinkReceipts.intentId, intentId),
        eq(issuerIdentityLinkReceipts.nonceHash, nonceHash)
      ),
    });
    if (
      !concurrent ||
      concurrent.issuerSubject !== issuerSubject ||
      concurrent.userId !== userId ||
      concurrent.consumedAt ||
      concurrent.expiresAt <= new Date()
    ) {
      throw new Error("identity link intent cannot be replayed");
    }
    return {
      receiptId: concurrent.receiptId,
      expiresAt: concurrent.expiresAt,
    };
  });
}

export async function consumeIssuerIdentityLinkReceipt(input: {
  issuerId: string;
  issuerSubject: string;
  intentId: string;
  nonce: string;
  receiptId: string;
}): Promise<
  | {
      /** First successful consumption of this browser proof. */
      status: "consumed";
      userId: string;
      issuerSubject: string;
    }
  | {
      /**
       * The exact issuer proof was already consumed. Returning the same
       * result lets the issuer recover a lost response after its own ledger
       * write failed; it never replays a Pod mutation or accepts a different
       * receipt, subject, intent, nonce, or expired proof.
       */
      status: "already-consumed";
      userId: string;
      issuerSubject: string;
    }
  | { status: "not-found" }
> {
  const now = new Date();
  const receiptId = input.receiptId.trim();
  const issuerId = input.issuerId.trim();
  const issuerSubject = input.issuerSubject.trim();
  const intentId = input.intentId.trim();
  const nonceHash = hashNonce(input.nonce.trim());
  const [receipt] = await db
    .update(issuerIdentityLinkReceipts)
    .set({ consumedAt: now })
    .where(
      and(
        eq(issuerIdentityLinkReceipts.receiptId, receiptId),
        eq(issuerIdentityLinkReceipts.issuerId, issuerId),
        eq(issuerIdentityLinkReceipts.issuerSubject, issuerSubject),
        eq(issuerIdentityLinkReceipts.intentId, intentId),
        eq(issuerIdentityLinkReceipts.nonceHash, nonceHash),
        isNull(issuerIdentityLinkReceipts.consumedAt),
        gt(issuerIdentityLinkReceipts.expiresAt, now)
      )
    )
    .returning({
      userId: issuerIdentityLinkReceipts.userId,
      issuerSubject: issuerIdentityLinkReceipts.issuerSubject,
    });
  if (receipt) return { status: "consumed", ...receipt };

  // A Control Plane response can be lost after the Pod has atomically marked
  // this receipt consumed but before the CP writes its discovery ledger. The
  // caller is still presenting a fresh signed issuer assertion, and every
  // proof-binding field below must match, so replaying this *read* is safe.
  // Keep the original expiry boundary: an old receipt cannot be used as a
  // durable access oracle.
  const alreadyConsumed = await db.query.issuerIdentityLinkReceipts.findFirst({
    where: and(
      eq(issuerIdentityLinkReceipts.receiptId, receiptId),
      eq(issuerIdentityLinkReceipts.issuerId, issuerId),
      eq(issuerIdentityLinkReceipts.issuerSubject, issuerSubject),
      eq(issuerIdentityLinkReceipts.intentId, intentId),
      eq(issuerIdentityLinkReceipts.nonceHash, nonceHash),
      isNotNull(issuerIdentityLinkReceipts.consumedAt),
      gt(issuerIdentityLinkReceipts.expiresAt, now)
    ),
    columns: {
      userId: true,
      issuerSubject: true,
    },
  });
  return alreadyConsumed
    ? { status: "already-consumed", ...alreadyConsumed }
    : { status: "not-found" };
}

/** Apply one exact trusted-issuer membership command atomically. */
export async function activateFederatedMember(
  input: ActivateFederatedMemberInput
): Promise<ActivateFederatedMemberResult> {
  const commandId = input.commandId.trim();
  const issuerId = input.issuerId.trim();
  const issuerSubject = input.issuerSubject.trim();
  const identityId = input.kratosIdentityId.trim();
  const workspaceId =
    input.scopeKind === "workspace" ? input.workspaceId.trim() : null;
  const projectId =
    input.scopeKind === "project" ? input.projectId.trim() : null;
  const email = normalizeEmail(input.email);
  const name = input.name?.trim() || null;
  if (
    !commandId ||
    !issuerId ||
    !issuerSubject ||
    !identityId ||
    !email ||
    (input.scopeKind === "workspace" ? !workspaceId : !projectId)
  ) {
    throw new Error(
      "activateFederatedMember: required command claims are missing"
    );
  }

  const result = await db.transaction(async (tx) => {
    const receipt = await tx.query.federatedAccessReceipts.findFirst({
      where: and(
        eq(federatedAccessReceipts.issuerId, issuerId),
        eq(federatedAccessReceipts.commandId, commandId)
      ),
    });
    if (receipt) {
      const matches =
        receipt.issuerSubject === issuerSubject &&
        receipt.userId === identityId &&
        receipt.scopeKind === input.scopeKind &&
        receipt.workspaceId === workspaceId &&
        receipt.projectId === projectId &&
        receipt.role === input.role;
      if (!matches) {
        throw new Error("activateFederatedMember: command id was reused");
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

    const [subjectLink, userLink, emailUser, workspace, project] =
      await Promise.all([
        tx.query.federatedIdentityLinks.findFirst({
          where: and(
            eq(federatedIdentityLinks.issuerId, issuerId),
            eq(federatedIdentityLinks.issuerSubject, issuerSubject)
          ),
          columns: { userId: true },
        }),
        tx.query.federatedIdentityLinks.findFirst({
          where: and(
            eq(federatedIdentityLinks.issuerId, issuerId),
            eq(federatedIdentityLinks.userId, identityId)
          ),
          columns: { issuerSubject: true },
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
    if (!workspaceId && projectId) {
      if (!project || project.status !== "active") {
        throw new Error(
          "activateFederatedMember: requested project is not active"
        );
      }
      if (project.workspaceId) {
        const parent = await tx.query.workspaces.findFirst({
          where: eq(workspaces.id, project.workspaceId),
          columns: { systemSlug: true, archivedAt: true },
        });
        if (!parent || parent.archivedAt || parent.systemSlug) {
          throw new Error(
            "activateFederatedMember: project parent is unavailable"
          );
        }
      }
    }
    if (workspaceId && !workspace) {
      throw new Error(
        "activateFederatedMember: requested workspace does not exist"
      );
    }
    if (workspace?.archivedAt || workspace?.systemSlug) {
      throw new Error(
        "activateFederatedMember: workspace cannot accept members"
      );
    }
    if (subjectLink && subjectLink.userId !== identityId) {
      throw new Error(
        "activateFederatedMember: issuer subject maps to another user"
      );
    }
    if (userLink && userLink.issuerSubject !== issuerSubject) {
      throw new Error(
        "activateFederatedMember: user maps to another issuer subject"
      );
    }
    if (emailUser && emailUser.id !== identityId) {
      throw new Error(
        "activateFederatedMember: email maps to another Pod user"
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
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    if (!subjectLink) {
      const createdLink = await tx
        .insert(federatedIdentityLinks)
        .values({
          issuerId,
          issuerSubject,
          userId: identityId,
          linkedByUserId: null,
        })
        .onConflictDoNothing()
        .returning({ userId: federatedIdentityLinks.userId });
      if (!createdLink[0]) {
        const concurrentLink = await tx.query.federatedIdentityLinks.findFirst({
          where: and(
            eq(federatedIdentityLinks.issuerId, issuerId),
            eq(federatedIdentityLinks.issuerSubject, issuerSubject)
          ),
          columns: { userId: true },
        });
        if (!concurrentLink || concurrentLink.userId !== identityId) {
          throw new Error(
            "activateFederatedMember: issuer subject maps to another user"
          );
        }
      }
    }

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
    // The role actually held after this grant. For a NEW membership it is the
    // invited role; for an EXISTING one it is whichever is more privileged, so
    // the invite is idempotent and never downgrades a member who already has
    // broader access (the previous code threw here, turning "you already have
    // access" into a hard redemption failure — the exact scenario a returning
    // Pod-wide member hits).
    let effectiveRole = input.role;
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
    } else if (roleRank(input.role) > roleRank(existingMembership.role)) {
      // Upgrade only — an invite may raise access, never lower it.
      if (workspaceId) {
        await tx
          .update(workspaceMembers)
          .set({ role: input.role })
          .where(eq(workspaceMembers.id, existingMembership.id));
      } else {
        await tx
          .update(projectMembers)
          .set({ role: input.role })
          .where(eq(projectMembers.id, existingMembership.id));
      }
    } else {
      // Equal or lower invited role → keep what they already have.
      effectiveRole = existingMembership.role as typeof input.role;
    }

    // The receipt records the COMMAND (its requested role), not the resulting
    // membership — it must stay `input.role` so a replay of the same commandId
    // still matches the idempotency guard above.
    await tx.insert(federatedAccessReceipts).values({
      issuerId,
      commandId,
      issuerSubject,
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
      // The role actually held after this grant (may exceed the invited role
      // when the member already had broader access).
      role: effectiveRole,
      alreadyActivated: false,
      membershipCreated,
    } as const;
  });

  logger.info(
    { issuerId, commandId, userId: result.userId, scopeKind: result.scopeKind },
    "Federated member grant applied"
  );
  return result;
}

/** Seed an owner and optionally bind a generic issuer identity. */
export async function seedAdminUser(
  input: SeedAdminUserInput
): Promise<SeedAdminUserResult> {
  const email = normalizeEmail(input.email);
  const identityId = input.kratosIdentityId.trim();
  const federatedIdentity = input.federatedIdentity
    ? {
        issuerId: input.federatedIdentity.issuerId.trim(),
        issuerSubject: input.federatedIdentity.issuerSubject.trim(),
      }
    : null;
  if (!email || !identityId) {
    throw new Error("seedAdminUser: email and kratosIdentityId are required");
  }
  if (
    federatedIdentity &&
    (!federatedIdentity.issuerId || !federatedIdentity.issuerSubject)
  ) {
    throw new Error("seedAdminUser: federated identity is incomplete");
  }
  const name = input.name?.trim() || undefined;
  const emailVerified = input.emailVerified ?? true;

  const result = await db.transaction(async (tx) => {
    if (input.requireUnclaimedPodOwner) {
      if (!federatedIdentity) {
        throw new Error(
          "seedAdminUser: initial owner bootstrap requires a federated identity"
        );
      }

      // A Pod has no singleton configuration row, so use one transaction-level
      // PostgreSQL lock to make first-owner claims deterministic across API
      // processes. The lock is released with this transaction.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('synap:initial-federated-owner-bootstrap'))`
      );
      const ownerRows = await tx
        .select({
          userId: workspaceMembers.userId,
          role: workspaceMembers.role,
        })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(
          and(
            eq(workspaces.systemSlug, "pod-admin"),
            eq(users.userType, "human")
          )
        );
      const existingOwnerIds = new Set(
        ownerRows
          .filter((owner) => owner.role === "owner" || owner.role === "admin")
          .map((owner) => owner.userId)
      );
      if (existingOwnerIds.size > 0) {
        const matchingLink = await tx.query.federatedIdentityLinks.findFirst({
          where: and(
            eq(federatedIdentityLinks.issuerId, federatedIdentity.issuerId),
            eq(
              federatedIdentityLinks.issuerSubject,
              federatedIdentity.issuerSubject
            )
          ),
          columns: { userId: true },
        });
        if (
          !matchingLink ||
          [...existingOwnerIds].some(
            (ownerId) => ownerId !== matchingLink.userId
          )
        ) {
          throw new PodOwnerAlreadyClaimedError();
        }
      }
    }

    const existingUser = await tx.query.users.findFirst({
      where: eq(users.id, identityId),
      columns: { id: true },
    });
    if (federatedIdentity) {
      const [subjectLink, userLink] = await Promise.all([
        tx.query.federatedIdentityLinks.findFirst({
          where: and(
            eq(federatedIdentityLinks.issuerId, federatedIdentity.issuerId),
            eq(
              federatedIdentityLinks.issuerSubject,
              federatedIdentity.issuerSubject
            )
          ),
          columns: { userId: true },
        }),
        tx.query.federatedIdentityLinks.findFirst({
          where: and(
            eq(federatedIdentityLinks.issuerId, federatedIdentity.issuerId),
            eq(federatedIdentityLinks.userId, identityId)
          ),
          columns: { issuerSubject: true },
        }),
      ]);
      if (subjectLink && subjectLink.userId !== identityId) {
        throw new Error(
          "seedAdminUser: issuer subject maps to another Pod user"
        );
      }
      if (
        userLink &&
        userLink.issuerSubject !== federatedIdentity.issuerSubject
      ) {
        throw new Error(
          "seedAdminUser: Pod user maps to another issuer subject"
        );
      }
    }

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
    if (federatedIdentity) {
      const createdLink = await tx
        .insert(federatedIdentityLinks)
        .values({
          issuerId: federatedIdentity.issuerId,
          issuerSubject: federatedIdentity.issuerSubject,
          userId: identityId,
        })
        .onConflictDoNothing()
        .returning({ userId: federatedIdentityLinks.userId });
      if (!createdLink[0]) {
        const concurrentLink = await tx.query.federatedIdentityLinks.findFirst({
          where: and(
            eq(federatedIdentityLinks.issuerId, federatedIdentity.issuerId),
            eq(
              federatedIdentityLinks.issuerSubject,
              federatedIdentity.issuerSubject
            )
          ),
          columns: { userId: true },
        });
        if (!concurrentLink || concurrentLink.userId !== identityId) {
          throw new Error(
            "seedAdminUser: issuer subject maps to another Pod user"
          );
        }
      }
    }

    // Every first Pod owner must also be an owner of the system administration
    // workspace. Without this invariant, a user can authenticate but cannot
    // administer trusted issuers or recover the Pod. This state is entirely
    // local; it does not depend on the external issuer that authenticated them.
    let podAdminWorkspace = await tx.query.workspaces.findFirst({
      where: eq(workspaces.systemSlug, "pod-admin"),
      columns: { id: true },
    });
    if (!podAdminWorkspace) {
      const [createdPodAdminWorkspace] = await tx
        .insert(workspaces)
        .values({
          ownerId: identityId,
          name: "Pod Admin",
          workspaceType: "operational",
          systemSlug: "pod-admin",
          settings: { systemSlug: "pod-admin" },
        })
        .returning({ id: workspaces.id });
      if (!createdPodAdminWorkspace) {
        throw new Error("seedAdminUser: failed to create pod-admin workspace");
      }
      podAdminWorkspace = createdPodAdminWorkspace;
    }
    const podAdminMembership = await tx.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
        eq(workspaceMembers.userId, identityId)
      ),
      columns: { role: true },
    });
    if (!podAdminMembership) {
      await tx.insert(workspaceMembers).values({
        workspaceId: podAdminWorkspace.id,
        userId: identityId,
        role: "owner",
      });
    } else if (
      podAdminMembership.role !== "owner" &&
      podAdminMembership.role !== "admin"
    ) {
      await tx
        .update(workspaceMembers)
        .set({ role: "owner" })
        .where(
          and(
            eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
            eq(workspaceMembers.userId, identityId)
          )
        );
    }

    // Query the user's own non-system workspace directly. A generic
    // `findFirst` membership can return pod-admin, which made an otherwise
    // idempotent bootstrap create another personal workspace on retry.
    const existingPersonalWorkspace = await tx.query.workspaces.findFirst({
      where: and(
        eq(workspaces.ownerId, identityId),
        isNull(workspaces.systemSlug),
        isNull(workspaces.archivedAt)
      ),
      columns: { id: true },
    });
    if (existingPersonalWorkspace) {
      return {
        workspaceId: existingPersonalWorkspace.id,
        alreadyExisted: !!existingUser,
      };
    }

    const [workspace] = await tx
      .insert(workspaces)
      .values({
        ownerId: identityId,
        name: `${email.split("@")[0]}'s workspace`,
        workspaceType: "personal",
        settings: {
          createdBy: "provisioning",
          provisionedAt: new Date().toISOString(),
        },
      })
      .returning({ id: workspaces.id });
    if (!workspace)
      throw new Error("seedAdminUser: failed to create workspace");
    await tx.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId: identityId,
      role: "owner",
    });

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
      await tx.insert(users).values({
        id: twinId,
        email: `agent-twin-${twinId.slice(0, 8)}@synap.agent`,
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
    { email, userId: identityId, workspaceId: result.workspaceId },
    "Pod user seeded"
  );
  return { userId: identityId, ...result };
}
