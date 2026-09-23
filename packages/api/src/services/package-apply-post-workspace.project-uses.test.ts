/**
 * package-apply-post-workspace — project --uses--> workspace INDEX.
 *
 * Company OS templates install CLEAN (zero seed entities). The uses-edge must
 * still land, and the receipt must say `linked` with `entities: 0` — not the
 * lying `not_linked` / "project is not visible or no longer exists".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { linkProjectToWorkspaceMock, linkEntityToProjectMock, entityRows } =
  vi.hoisted(() => ({
    linkProjectToWorkspaceMock: vi.fn(),
    linkEntityToProjectMock: vi.fn(),
    entityRows: { current: [] as { id: string }[] },
  }));

vi.mock("../utils/project-workspace.js", () => ({
  linkProjectToWorkspace: (...args: unknown[]) =>
    linkProjectToWorkspaceMock(...args),
}));

vi.mock("./links/links-service.js", () => ({
  createLinks: vi.fn(async () => []),
}));

vi.mock("../routers/playbooks.js", () => ({
  playbooksRouter: { createCaller: () => ({ create: vi.fn() }) },
}));

vi.mock("../routers/hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: vi.fn(async () => ({})),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    linkEntityToProject: (...args: unknown[]) =>
      linkEntityToProjectMock(...args),
    db: {
      select: () => ({
        from: () => ({
          where: async () => entityRows.current,
        }),
      }),
    },
  };
});

import { applyPackagePostWorkspace } from "./package-apply-post-workspace.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

const apply = () =>
  applyPackagePostWorkspace({
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    body: { projectId: PROJECT_ID },
  });

beforeEach(() => {
  linkProjectToWorkspaceMock.mockReset();
  linkEntityToProjectMock.mockReset();
  entityRows.current = [];
  linkProjectToWorkspaceMock.mockResolvedValue({ linked: true });
  linkEntityToProjectMock.mockResolvedValue({ linked: true });
});

describe("applyPackagePostWorkspace — project uses-edge", () => {
  it("zero seed entities still stamps uses-edge and reports linked", async () => {
    entityRows.current = [];

    const res = await apply();

    expect(linkProjectToWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(linkProjectToWorkspaceMock).toHaveBeenCalledWith(expect.anything(), {
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
    });
    expect(linkEntityToProjectMock).not.toHaveBeenCalled();
    expect(res.projectLink).toEqual({
      status: "linked",
      projectId: PROJECT_ID,
      entities: 0,
    });
  });

  it("a missing/invisible project does NOT claim linked and never files entities as linked", async () => {
    entityRows.current = [{ id: "e1" }];
    linkProjectToWorkspaceMock.mockResolvedValue({
      linked: false,
      reason: "project_not_found",
    });
    linkEntityToProjectMock.mockResolvedValue({
      linked: false,
      reason: "project_not_found",
    });

    const res = await apply();

    expect(linkProjectToWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(res.projectLink).toMatchObject({
      status: "not_linked",
      projectId: PROJECT_ID,
      entities: 0,
      refused: 1,
    });
    expect((res.projectLink as { message: string }).message).toContain(
      "not visible or no longer exists"
    );
  });

  it("zero entities + missing project is not_linked (uses-edge refused, nothing to file)", async () => {
    entityRows.current = [];
    linkProjectToWorkspaceMock.mockResolvedValue({
      linked: false,
      reason: "project_not_found",
    });

    const res = await apply();

    expect(linkEntityToProjectMock).not.toHaveBeenCalled();
    expect(res.projectLink).toMatchObject({
      status: "not_linked",
      projectId: PROJECT_ID,
      entities: 0,
    });
  });

  it("stamps the uses-edge BEFORE filing seed entities", async () => {
    entityRows.current = [{ id: "e1" }, { id: "e2" }];

    await apply();

    const usesOrder = linkProjectToWorkspaceMock.mock.invocationCallOrder[0];
    const entityOrder = linkEntityToProjectMock.mock.invocationCallOrder[0];
    expect(usesOrder).toBeDefined();
    expect(entityOrder).toBeDefined();
    expect(usesOrder!).toBeLessThan(entityOrder!);
    expect(linkEntityToProjectMock).toHaveBeenCalledTimes(2);
  });

  it("duplicate apply is idempotent — helper is called again, receipt stays linked", async () => {
    entityRows.current = [];

    const first = await apply();
    const second = await apply();

    expect(linkProjectToWorkspaceMock).toHaveBeenCalledTimes(2);
    expect(first.projectLink).toEqual(second.projectLink);
    expect(first.projectLink).toMatchObject({
      status: "linked",
      entities: 0,
    });
  });

  it("keeps filing seed entities when the uses-edge lands", async () => {
    entityRows.current = [{ id: "e1" }];

    const res = await apply();

    expect(linkEntityToProjectMock).toHaveBeenCalledWith(expect.anything(), {
      entityId: "e1",
      projectId: PROJECT_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(res.projectLink).toEqual({
      status: "linked",
      projectId: PROJECT_ID,
      entities: 1,
    });
  });
});

describe("applyPackagePostWorkspace — uses-edge source shape", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(
    join(here, "package-apply-post-workspace.ts"),
    "utf8"
  );

  it("calls linkProjectToWorkspace before linkEntityToProject in the project-link block", () => {
    const usesAt = src.indexOf("linkProjectToWorkspace");
    const entityAt = src.indexOf("linkEntityToProject(db");
    // Non-vacuity: both producers are in this file.
    expect(usesAt).toBeGreaterThan(0);
    expect(entityAt).toBeGreaterThan(0);
    expect(usesAt).toBeLessThan(entityAt);
  });

  it("the project-link block does not write workspace_members", () => {
    const start = src.indexOf("Project link (INDEX");
    const end = src.indexOf("return result;");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).not.toMatch(
      /workspaceMembers|workspace_members|getWorkspaceMembership/
    );
    expect(block).toContain("linkProjectToWorkspace");
  });
});

describe("applyPackagePostWorkspace — project linking flow", () => {
  it("install with projectId links correctly and shows linked status", async () => {
    entityRows.current = [{ id: "e1" }, { id: "e2" }];
    linkProjectToWorkspaceMock.mockResolvedValue({ linked: true });
    linkEntityToProjectMock.mockResolvedValue({ linked: true });

    const res = await applyPackagePostWorkspace({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      body: { projectId: PROJECT_ID },
    });

    expect(linkProjectToWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(linkProjectToWorkspaceMock).toHaveBeenCalledWith(expect.anything(), {
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
    });
    expect(linkEntityToProjectMock).toHaveBeenCalledTimes(2);
    expect(linkEntityToProjectMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      {
        entityId: "e1",
        projectId: PROJECT_ID,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
      }
    );
    expect(linkEntityToProjectMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      {
        entityId: "e2",
        projectId: PROJECT_ID,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
      }
    );
    expect(res.projectLink).toEqual({
      status: "linked",
      projectId: PROJECT_ID,
      entities: 2,
    });
  });

  it("install with projectId correctly links entities to project", async () => {
    entityRows.current = [{ id: "e1" }, { id: "e2" }];
    linkProjectToWorkspaceMock.mockResolvedValue({ linked: true });
    linkEntityToProjectMock.mockResolvedValue({ linked: true });

    const res = await applyPackagePostWorkspace({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      body: { projectId: PROJECT_ID },
    });

    expect(res.projectLink).toEqual({
      status: "linked",
      projectId: PROJECT_ID,
      entities: 2,
    });
  });
});
