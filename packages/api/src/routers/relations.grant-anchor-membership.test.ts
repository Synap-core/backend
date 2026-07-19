/**
 * P3 W1 TRIPWIRE — `relations.grantAnchorMembership` anchor id-space fix.
 *
 * `project_members.project_id` FKs to `projects(id)` (post-0151 distinct id
 * spaces), but the procedure used to resolve its anchor from `entities` — so a
 * grant on any non-project anchor passed the guard and then violated the FK at
 * insert time. The fix resolves the anchor from the PROJECTS table:
 *
 *   1. a project anchor → the member row is created with the projects-table id;
 *   2. an entity-id anchor (no projects row) → typed BAD_REQUEST rejection
 *      ("anchor must be a project"), and NO insert / membership write happens.
 *
 * Mock style follows relations.get-connections.test.ts: partial-mock
 * `@synap/database` (keep the real schema objects so the `.from(<table>)`
 * assertion is against the REAL `projects` table), stub the collaborators.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetDb,
  mockAddMember,
  mockRepoCtor,
  mockCheckPermission,
  fromTables,
} = vi.hoisted(() => {
  const fromTables: unknown[] = [];
  const mockAddMember = vi.fn();
  const mockRepoCtor = vi.fn();
  // Per-select result queue: each `.select().from(t).where().limit()` chain
  // records its `from` table and resolves the next queued row list.
  const selectQueue: unknown[][] = [];
  const mockDatabase = {
    select: () => ({
      from: (t: unknown) => {
        fromTables.push(t);
        return {
          where: () => ({
            limit: () => Promise.resolve(selectQueue.shift() ?? []),
          }),
        };
      },
    }),
    __queue: selectQueue,
  };
  return {
    mockGetDb: vi.fn(async () => mockDatabase),
    mockAddMember,
    mockRepoCtor,
    mockCheckPermission: vi.fn(),
    fromTables,
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: mockGetDb,
    eventRepository: { __shared: true },
    ProjectMemberRepository: class {
      constructor(...args: unknown[]) {
        mockRepoCtor(...args);
      }
      add = mockAddMember;
    },
  };
});
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: mockCheckPermission,
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
// protectedProcedure's mutation middleware consults the split-brain guard,
// which reads sync_generation from the live DB — stub it (same as
// proposals-revert.test.ts) so no Postgres connection is opened.
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { relationsRouter } from "./relations.js";
import { projects, entities } from "@synap/database/schema";

const ADMIN = "00000000-0000-4000-8000-0000000000aa";
const GRANTEE = "00000000-0000-4000-8000-0000000000bb";
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const ENTITY_ID = "00000000-0000-4000-8000-000000000002";
const WS = "00000000-0000-4000-8000-000000000010";

const caller = relationsRouter.createCaller({
  authenticated: true,
  userId: ADMIN,
} as never);

async function queue(rows: unknown[][]) {
  const db = (await mockGetDb()) as unknown as { __queue: unknown[][] };
  db.__queue.length = 0;
  db.__queue.push(...rows);
}

beforeEach(() => {
  vi.clearAllMocks();
  fromTables.length = 0;
  mockCheckPermission.mockResolvedValue({ allowed: true });
  mockAddMember.mockResolvedValue({ id: "member-1" });
});

describe("grantAnchorMembership — anchor resolves from the PROJECTS id space", () => {
  it("project anchor: resolves via the projects table and inserts with the projects-table id", async () => {
    await queue([
      // 1st select: the anchor row FROM PROJECTS (owner = caller → admin gate passes)
      [{ id: PROJECT_ID, workspaceId: WS, userId: ADMIN }],
      // 2nd select: no existing membership
      [],
    ]);

    const res = await caller.grantAnchorMembership({
      anchorId: PROJECT_ID,
      userId: GRANTEE,
      role: "viewer",
    });

    expect(res).toEqual({ status: "created", memberId: "member-1" });
    // The anchor lookup targeted the REAL projects table — not entities.
    expect(fromTables[0]).toBe(projects);
    expect(fromTables).not.toContain(entities);
    // The membership write carries the projects-table id (FK-valid).
    expect(mockAddMember).toHaveBeenCalledTimes(1);
    expect(mockAddMember).toHaveBeenCalledWith(
      { projectId: PROJECT_ID, userId: GRANTEE, role: "viewer" },
      ADMIN
    );
  });

  it("entity-id anchor (no projects row): typed rejection, no insert attempted", async () => {
    await queue([[]]); // no projects row for this id — it is an entity id

    await expect(
      caller.grantAnchorMembership({
        anchorId: ENTITY_ID,
        userId: GRANTEE,
        role: "viewer",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining(
        "Anchor must be a project; entity anchors are not yet supported"
      ),
    });

    // The rejection is BEFORE any write path: no repo constructed, no add, no
    // permission ladder consulted.
    expect(mockAddMember).not.toHaveBeenCalled();
    expect(mockRepoCtor).not.toHaveBeenCalled();
    expect(mockCheckPermission).not.toHaveBeenCalled();
  });

  it("re-grant of an existing membership stays idempotent (exists, no new insert)", async () => {
    await queue([
      [{ id: PROJECT_ID, workspaceId: WS, userId: ADMIN }],
      [{ id: "member-existing" }],
    ]);

    const res = await caller.grantAnchorMembership({
      anchorId: PROJECT_ID,
      userId: GRANTEE,
      role: "viewer",
    });

    expect(res).toEqual({ status: "exists", memberId: "member-existing" });
    expect(mockAddMember).not.toHaveBeenCalled();
  });
});
