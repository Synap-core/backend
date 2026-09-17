/**
 * `linkProjectToWorkspace` is the ONE write path for `project --uses--> workspace`.
 *
 * The uses-edge is an INDEX, not an ACL. These tests are DB-free: a ghost
 * INDEX of a missing project, a workspace_members insert, or a second insert
 * path would all pass a "the function returned linked:true" assertion.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type LinkNeighbour = {
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  linkType: string;
};

const { ownerPrivateVisibleWhereMock, createLinkMock, getLinksForMock } =
  vi.hoisted(() => ({
    ownerPrivateVisibleWhereMock: vi.fn(() => ({ __wsFloor: true })),
    createLinkMock: vi.fn(
      async (_input?: unknown): Promise<{ id: string } | undefined> => ({
        id: "edge-1",
      })
    ),
    getLinksForMock: vi.fn(
      async (_userId?: string, _type?: string, _id?: string) =>
        [] as LinkNeighbour[]
    ),
  }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    ownerPrivateVisibleWhere: ownerPrivateVisibleWhereMock,
  };
});

vi.mock("../services/links/links-service.js", () => ({
  createLink: createLinkMock,
  getLinksFor: getLinksForMock,
  createLinks: vi.fn(),
}));

const {
  linkProjectToWorkspace,
  listWorkspacesUsedByProject,
  listWorkspacesUsedByProjects,
  listProjectsUsingWorkspace,
} = await import("./project-workspace.js");

function makeDb(selectRows: unknown[]) {
  const inserted: Array<{ table: unknown; values: unknown }> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = selectRows;
          return Object.assign(Promise.resolve(rows), {
            limit: async () => rows,
          });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        inserted.push({ table, values });
        return { onConflictDoNothing: async () => undefined };
      },
    }),
  };
  return { db, inserted };
}

const ARGS = {
  projectId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "33333333-3333-4333-8333-333333333333",
  userId: "user-1",
};

const HELPER_SRC = readFileSync(
  fileURLToPath(new URL("./project-workspace.ts", import.meta.url)),
  "utf8"
);

beforeEach(() => {
  ownerPrivateVisibleWhereMock.mockClear();
  createLinkMock.mockClear();
  getLinksForMock.mockClear();
  createLinkMock.mockResolvedValue({ id: "edge-1" });
});

describe("linkProjectToWorkspace — ghost-edge guard", () => {
  it("REFUSES and writes NOTHING when the project does not resolve", async () => {
    const { db, inserted } = makeDb([]);

    const result = await linkProjectToWorkspace(db as never, ARGS);

    expect(result.linked).toBe(false);
    expect((result as { reason?: string }).reason).toBe("project_not_found");
    expect(createLinkMock).not.toHaveBeenCalled();
    expect(
      inserted,
      "an unresolvable project must write NO row — a ghost uses-edge " +
        "is an INDEX of a project that does not exist"
    ).toEqual([]);
  });

  it("stamps project --uses--> workspace through createLink when the project resolves", async () => {
    const { db, inserted } = makeDb([{ id: ARGS.projectId }]);

    const result = await linkProjectToWorkspace(db as never, ARGS);

    expect(result.linked).toBe(true);
    expect(createLinkMock).toHaveBeenCalledTimes(1);
    expect(createLinkMock).toHaveBeenCalledWith({
      workspaceId: ARGS.workspaceId,
      fromType: "project",
      fromId: ARGS.projectId,
      toType: "workspace",
      toId: ARGS.workspaceId,
      linkType: "uses",
    });
    // The insert path is createLink, not a second db.insert(links).
    expect(inserted).toEqual([]);
  });

  it("consults the workspace visibility floor on the PROJECT (existence, not ACL widening)", async () => {
    const { db } = makeDb([{ id: ARGS.projectId }]);
    await linkProjectToWorkspace(db as never, ARGS);

    expect(ownerPrivateVisibleWhereMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      ARGS.userId
    );
  });

  it("a second stamp is idempotent — createLink is the unique-index door", async () => {
    const { db } = makeDb([{ id: ARGS.projectId }]);
    createLinkMock.mockResolvedValueOnce({ id: "edge-1" });
    createLinkMock.mockResolvedValueOnce(undefined); // conflict skip

    const first = await linkProjectToWorkspace(db as never, ARGS);
    const second = await linkProjectToWorkspace(db as never, ARGS);

    expect(first.linked).toBe(true);
    expect(second.linked).toBe(true);
    expect(createLinkMock).toHaveBeenCalledTimes(2);
    expect(createLinkMock.mock.calls[0]?.[0]).toEqual(
      createLinkMock.mock.calls[1]?.[0]
    );
  });
});

describe("linkProjectToWorkspace — not an ACL", () => {
  it("never inserts workspace_members (or project_members) rows", async () => {
    const { db, inserted } = makeDb([{ id: ARGS.projectId }]);
    await linkProjectToWorkspace(db as never, ARGS);

    expect(inserted).toEqual([]);
    expect(createLinkMock.mock.calls[0]?.[0]).not.toHaveProperty("members");
  });

  it("the helper source does not import or name membership tables/APIs", () => {
    // Non-vacuity: this file is the producer we think it is.
    expect(HELPER_SRC).toContain('linkType: "uses"');
    expect(HELPER_SRC.length).toBeGreaterThan(500);

    // Strip comments so the header's "never writes workspace_members" prose
    // cannot be mistaken for a membership API call (the same comment-in-
    // source trap the LinkType SSOT tripwire was written to prevent).
    const code = HELPER_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /\/\/.*$/gm,
      ""
    );
    expect(code).toMatch(/createLink\(/);
    expect(code).not.toMatch(/workspaceMembers/);
    expect(code).not.toMatch(/workspace_members/);
    expect(code).not.toMatch(/getWorkspaceMembership/);
    expect(code).not.toMatch(/projectMembers/);
    expect(code).not.toMatch(/project_members/);
  });
});

describe("readers — same links graph, typed uses-edge", () => {
  it("listWorkspacesUsedByProject reuses getLinksFor and keeps only uses→workspace", async () => {
    getLinksForMock.mockResolvedValueOnce([
      {
        fromType: "project",
        fromId: ARGS.projectId,
        toType: "workspace",
        toId: ARGS.workspaceId,
        linkType: "uses",
      },
      {
        fromType: "project",
        fromId: ARGS.projectId,
        toType: "entity",
        toId: "entity-1",
        linkType: "targets",
      },
      {
        fromType: "session",
        fromId: "sess-1",
        toType: "tool",
        toId: "tool-1",
        linkType: "used",
      },
    ]);

    const ids = await listWorkspacesUsedByProject(ARGS.userId, ARGS.projectId);

    expect(getLinksForMock).toHaveBeenCalledWith(
      ARGS.userId,
      "project",
      ARGS.projectId
    );
    expect(ids).toEqual([ARGS.workspaceId]);
  });

  it("listWorkspacesUsedByProjects groups workspace ids by project", async () => {
    const otherWs = "44444444-4444-4444-8444-444444444444";
    const { db } = makeDb([
      { fromId: ARGS.projectId, toId: ARGS.workspaceId },
      { fromId: ARGS.projectId, toId: otherWs },
      { fromId: "other-project", toId: ARGS.workspaceId },
    ]);

    const map = await listWorkspacesUsedByProjects(db as never, [
      ARGS.projectId,
      "other-project",
    ]);

    expect(map.get(ARGS.projectId)).toEqual([ARGS.workspaceId, otherWs]);
    expect(map.get("other-project")).toEqual([ARGS.workspaceId]);
  });

  it("listProjectsUsingWorkspace is the reverse of the same edge", async () => {
    const { db } = makeDb([
      { fromId: ARGS.projectId },
      { fromId: ARGS.projectId },
      { fromId: "other-project" },
    ]);

    const ids = await listProjectsUsingWorkspace(db as never, ARGS.workspaceId);
    expect(ids).toEqual([ARGS.projectId, "other-project"]);
  });

  it("the source carries a typed reader the SSOT tripwire can see", () => {
    // Non-vacuity + the exact `linkType, "uses"` shape liveLinkTypes hunts.
    expect(HELPER_SRC).toMatch(/linkType,\s*"uses"/);
    expect(
      HELPER_SRC.match(/linkType,\s*"uses"/g)?.length
    ).toBeGreaterThanOrEqual(2);
  });
});
