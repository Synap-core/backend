import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const activationFind = vi.fn();
  const userFind = vi.fn();
  const workspaceFind = vi.fn();
  const projectFind = vi.fn();
  const workspaceMemberFind = vi.fn();
  const projectMemberFind = vi.fn();
  const insertedValues: Array<Record<string, unknown>> = [];
  const insert = vi.fn(() => ({
    values: vi.fn((values: Record<string, unknown>) => {
      insertedValues.push(values);
      return { onConflictDoUpdate: vi.fn(async () => undefined) };
    }),
  }));
  const tx = {
    query: {
      controlPlaneMemberActivations: { findFirst: activationFind },
      users: { findFirst: userFind },
      workspaces: { findFirst: workspaceFind },
      projects: { findFirst: projectFind },
      workspaceMembers: { findFirst: workspaceMemberFind },
      projectMembers: { findFirst: projectMemberFind },
    },
    insert,
  };
  return {
    activationFind,
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

import {
  activateControlPlaneMember,
  seedAdminUser,
} from "./user-provisioning.js";

const baseInput = {
  activationId: "activation-1",
  controlPlaneUserId: "cp-user-1",
  kratosIdentityId: "pod-user-1",
  email: "person@example.com",
  role: "viewer" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertedValues.length = 0;
  mocks.activationFind.mockResolvedValue(undefined);
  mocks.userFind.mockResolvedValue(undefined);
  mocks.workspaceFind.mockResolvedValue(undefined);
  mocks.projectFind.mockResolvedValue(undefined);
  mocks.workspaceMemberFind.mockResolvedValue(undefined);
  mocks.projectMemberFind.mockResolvedValue(undefined);
});

describe("activateControlPlaneMember", () => {
  it("creates only project membership for a project-scoped activation", async () => {
    mocks.projectFind.mockResolvedValue({
      id: "project-1",
      workspaceId: null,
      status: "active",
    });

    const result = await activateControlPlaneMember({
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
      activateControlPlaneMember({
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
      activateControlPlaneMember({
        ...baseInput,
        scopeKind: "workspace",
        workspaceId: "pod-admin",
      })
    ).rejects.toThrow("cannot accept external members");
    expect(mocks.workspaceMemberFind).not.toHaveBeenCalled();
  });
});

describe("seedAdminUser", () => {
  it("persists the signed Control Plane user mapping for a managed owner", async () => {
    mocks.userFind
      .mockResolvedValueOnce({
        id: "pod-user-1",
        controlPlaneUserId: null,
      })
      .mockResolvedValueOnce(undefined);
    mocks.workspaceMemberFind.mockResolvedValue({
      workspaceId: "workspace-1",
      workspace: { settings: {} },
    });

    const result = await seedAdminUser({
      kratosIdentityId: "pod-user-1",
      controlPlaneUserId: "cp-user-1",
      email: "person@example.com",
    });

    expect(result).toEqual({
      userId: "pod-user-1",
      workspaceId: "workspace-1",
      alreadyExisted: true,
    });
    expect(mocks.insertedValues).toContainEqual(
      expect.objectContaining({
        id: "pod-user-1",
        controlPlaneUserId: "cp-user-1",
      })
    );
  });
});
