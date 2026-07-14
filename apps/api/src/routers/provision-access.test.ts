import { describe, expect, it } from "vitest";
import { projectPodUserAccess } from "./provision-access.js";

describe("projectPodUserAccess", () => {
  it("separates Pod ownership from exact workspace roles", () => {
    expect(
      projectPodUserAccess([
        { workspaceId: "admin", role: "owner", systemSlug: "pod-admin" },
        { workspaceId: "crm", role: "admin", systemSlug: null },
      ])
    ).toEqual({
      podRole: "owner",
      workspaceScopes: [{ workspaceId: "crm", role: "admin" }],
      projectScopes: [],
    });
  });

  it("does not promote ordinary workspace membership to Pod administration", () => {
    expect(
      projectPodUserAccess([
        { workspaceId: "crm", role: "editor", systemSlug: null },
      ])
    ).toEqual({
      podRole: "member",
      workspaceScopes: [{ workspaceId: "crm", role: "editor" }],
      projectScopes: [],
    });
  });

  it("omits malformed legacy workspace roles", () => {
    expect(
      projectPodUserAccess([
        { workspaceId: "crm", role: "superuser", systemSlug: null },
      ])
    ).toEqual({
      podRole: "member",
      workspaceScopes: [],
      projectScopes: [],
    });
  });

  it("projects active project membership without inventing workspace access", () => {
    expect(
      projectPodUserAccess(
        [],
        [
          {
            projectId: "project-1",
            workspaceId: "crm",
            role: "viewer",
            status: "active",
          },
        ]
      )
    ).toEqual({
      podRole: "member",
      workspaceScopes: [],
      projectScopes: [
        {
          projectId: "project-1",
          workspaceId: "crm",
          role: "viewer",
        },
      ],
    });
  });

  it("omits archived projects and malformed project roles", () => {
    expect(
      projectPodUserAccess(
        [],
        [
          {
            projectId: "archived",
            workspaceId: null,
            role: "viewer",
            status: "archived",
          },
          {
            projectId: "malformed",
            workspaceId: null,
            role: "superuser",
            status: "active",
          },
        ]
      )
    ).toEqual({
      podRole: "member",
      workspaceScopes: [],
      projectScopes: [],
    });
  });

  it("omits projects whose parent workspace is archived or internal", () => {
    expect(
      projectPodUserAccess(
        [],
        [
          {
            projectId: "archived-parent",
            workspaceId: "workspace-1",
            role: "viewer",
            status: "active",
            workspaceArchivedAt: new Date(),
            workspaceSystemSlug: null,
          },
          {
            projectId: "system-parent",
            workspaceId: "workspace-2",
            role: "viewer",
            status: "active",
            workspaceArchivedAt: null,
            workspaceSystemSlug: "pod-admin",
          },
        ]
      )
    ).toEqual({
      podRole: "member",
      workspaceScopes: [],
      projectScopes: [],
    });
  });
});
