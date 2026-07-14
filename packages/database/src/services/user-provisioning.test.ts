import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const accessReceiptFind = vi.fn();
  const identityLinkFind = vi.fn();
  const userFind = vi.fn();
  const workspaceFind = vi.fn();
  const projectFind = vi.fn();
  const workspaceMemberFind = vi.fn();
  const projectMemberFind = vi.fn();
  const insertedValues: Array<Record<string, unknown>> = [];
  const insert = vi.fn(() => ({
    values: vi.fn((values: Record<string, unknown>) => {
      insertedValues.push(values);
      return {
        returning: vi.fn(async () => [
          { ...values, id: values.id ?? "generated-row-id" },
        ]),
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => [values]),
        })),
        onConflictDoUpdate: vi.fn(async () => undefined),
      };
    }),
  }));
  const tx = {
    query: {
      federatedAccessReceipts: { findFirst: accessReceiptFind },
      federatedIdentityLinks: { findFirst: identityLinkFind },
      issuerIdentityLinkReceipts: { findFirst: vi.fn() },
      users: { findFirst: userFind },
      workspaces: { findFirst: workspaceFind },
      projects: { findFirst: projectFind },
      workspaceMembers: { findFirst: workspaceMemberFind },
      projectMembers: { findFirst: projectMemberFind },
    },
    insert,
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
  };
  return {
    accessReceiptFind,
    identityLinkFind,
    userFind,
    workspaceFind,
    projectFind,
    workspaceMemberFind,
    projectMemberFind,
    insertedValues,
    insert,
    tx,
  };
});

vi.mock("../client-pg.js", () => ({
  db: {
    transaction: (callback: (tx: typeof mocks.tx) => unknown) =>
      callback(mocks.tx),
  },
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn() }),
}));

import { activateFederatedMember, seedAdminUser } from "./user-provisioning.js";
import { projectPodUserAccess } from "./pod-user-access.js";

const baseInput = {
  commandId: "grant-1",
  issuerId: "issuer-a",
  issuerSubject: "external-user-1",
  kratosIdentityId: "pod-user-1",
  email: "person@example.com",
  role: "viewer" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertedValues.length = 0;
  mocks.accessReceiptFind.mockResolvedValue(undefined);
  mocks.identityLinkFind.mockResolvedValue(undefined);
  mocks.userFind.mockResolvedValue(undefined);
  mocks.workspaceFind.mockResolvedValue(undefined);
  mocks.projectFind.mockResolvedValue(undefined);
  mocks.workspaceMemberFind.mockResolvedValue(undefined);
  mocks.projectMemberFind.mockResolvedValue(undefined);
});

describe("activateFederatedMember", () => {
  it("creates only project membership for a project-scoped issuer command", async () => {
    mocks.projectFind.mockResolvedValue({
      id: "project-1",
      workspaceId: null,
      status: "active",
    });

    const result = await activateFederatedMember({
      ...baseInput,
      scopeKind: "project",
      projectId: "project-1",
    });

    expect(result).toMatchObject({
      scopeKind: "project",
      workspaceId: null,
      projectId: "project-1",
      membershipCreated: true,
    });
    expect(mocks.insertedValues).toContainEqual(
      expect.objectContaining({
        projectId: "project-1",
        userId: "pod-user-1",
        role: "viewer",
      })
    );
    expect(mocks.insertedValues).not.toContainEqual(
      expect.objectContaining({ workspaceId: expect.any(String) })
    );
  });

  it("rejects a role change instead of overwriting Pod truth", async () => {
    mocks.projectFind.mockResolvedValue({
      id: "project-1",
      workspaceId: null,
      status: "active",
    });
    mocks.projectMemberFind.mockResolvedValue({
      id: "member-1",
      role: "editor",
    });

    await expect(
      activateFederatedMember({
        ...baseInput,
        scopeKind: "project",
        projectId: "project-1",
      })
    ).rejects.toThrow("existing Pod role differs");
  });

  it("rejects system workspaces before writing membership", async () => {
    mocks.workspaceFind.mockResolvedValue({
      id: "pod-admin",
      systemSlug: "pod-admin",
      archivedAt: null,
    });

    await expect(
      activateFederatedMember({
        ...baseInput,
        scopeKind: "workspace",
        workspaceId: "pod-admin",
      })
    ).rejects.toThrow("workspace cannot accept members");
    expect(mocks.workspaceMemberFind).not.toHaveBeenCalled();
  });

  it("keeps identical command IDs isolated by issuer", async () => {
    mocks.projectFind.mockResolvedValue({
      id: "project-1",
      workspaceId: null,
      status: "active",
    });

    await activateFederatedMember({
      ...baseInput,
      scopeKind: "project",
      projectId: "project-1",
    });
    mocks.projectMemberFind.mockResolvedValue({
      id: "member-1",
      role: "viewer",
    });
    await activateFederatedMember({
      ...baseInput,
      issuerId: "issuer-b",
      scopeKind: "project",
      projectId: "project-1",
    });

    const receipts = mocks.insertedValues.filter(
      (value) => value.commandId === "grant-1"
    );
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ issuerId: "issuer-a" }),
        expect.objectContaining({ issuerId: "issuer-b" }),
      ])
    );
  });
});

describe("seedAdminUser", () => {
  it("persists an issuer-qualified identity link for a managed owner", async () => {
    mocks.userFind.mockResolvedValue({ id: "pod-user-1" });
    // The local Pod-admin workspace is created once, while the owner already
    // has a regular workspace. This keeps the test focused on the issuer link
    // rather than exercising personal-workspace/twin provisioning.
    mocks.workspaceFind
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: "workspace-1" });
    mocks.workspaceMemberFind
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ role: "owner" });

    const result = await seedAdminUser({
      kratosIdentityId: "pod-user-1",
      email: "person@example.com",
      federatedIdentity: {
        issuerId: "issuer-a",
        issuerSubject: "external-user-1",
      },
    });

    expect(result).toEqual({
      userId: "pod-user-1",
      workspaceId: "workspace-1",
      alreadyExisted: true,
    });
    expect(mocks.insertedValues).toContainEqual(
      expect.objectContaining({
        issuerId: "issuer-a",
        issuerSubject: "external-user-1",
        userId: "pod-user-1",
      })
    );
    expect(mocks.insertedValues).toContainEqual(
      expect.objectContaining({
        systemSlug: "pod-admin",
        workspaceType: "operational",
      })
    );
  });

  it("allows the same external subject to be linked independently per issuer", async () => {
    mocks.userFind.mockResolvedValue({ id: "pod-user-1" });
    mocks.workspaceFind
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: "workspace-1" })
      .mockResolvedValueOnce({ id: "pod-admin" })
      .mockResolvedValueOnce({ id: "workspace-1" });
    mocks.workspaceMemberFind
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ role: "owner" });

    for (const issuerId of ["issuer-a", "issuer-b"]) {
      await seedAdminUser({
        kratosIdentityId: "pod-user-1",
        email: "person@example.com",
        federatedIdentity: {
          issuerId,
          issuerSubject: "shared-subject",
        },
      });
    }

    const identityLinks = mocks.insertedValues.filter(
      (value) => value.issuerSubject === "shared-subject"
    );
    expect(identityLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ issuerId: "issuer-a" }),
        expect.objectContaining({ issuerId: "issuer-b" }),
      ])
    );
  });
});

describe("projectPodUserAccess", () => {
  it("excludes archived workspaces from user-facing scopes", () => {
    const access = projectPodUserAccess([
      {
        workspaceId: "archived-workspace",
        role: "viewer",
        systemSlug: null,
        workspaceArchivedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        workspaceId: "active-workspace",
        role: "editor",
        systemSlug: null,
        workspaceArchivedAt: null,
      },
    ]);

    expect(access.workspaceScopes).toEqual([
      {
        workspaceId: "active-workspace",
        role: "editor",
      },
    ]);
  });

  it("does not treat an archived pod-admin workspace as Pod-wide access", () => {
    const access = projectPodUserAccess([
      {
        workspaceId: "pod-admin",
        role: "owner",
        systemSlug: "pod-admin",
        workspaceArchivedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    expect(access.podRole).toBe("member");
    expect(access.workspaceScopes).toEqual([]);
  });
});
