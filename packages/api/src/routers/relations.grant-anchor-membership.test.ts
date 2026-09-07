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
import { EXPOSURE_RELATION_TYPES } from "../utils/project-scope.js";

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

/**
 * TRIPWIRE — the generic relation doors reject EVERY exposure edge, DERIVED.
 *
 * `EXPOSURE_RELATION_TYPES` has two members (`belongs_to_project`, `visible_to`)
 * and BOTH widen the access floor identically through `exposureMemberWhere` —
 * minting either GRANTS access. The `relations.create` / `relations.batchCreate`
 * guards used to check `visible_to` ONLY, and `relation.create` is in
 * `DEFAULT_AUTO_APPROVE`, so an agent's `belongs_to_project` edge would have
 * auto-executed. It did not leak only because `resolveVisibleRelationEndpoints`
 * resolves endpoints against `entities` and post-0151 projects are TABLE ROWS —
 * an id-space accident, not a guard, and one that evaporates silently the moment
 * projects are mirrored into `entities`.
 *
 * The cases below are GENERATED from the exported constant, so a third exposure
 * type is covered the day it is added — there is no second list to drift.
 * NON-VACUITY is asserted: a set that shrank below two members (or lost the
 * member this test was written for) fails loudly instead of reading green over
 * an empty loop.
 */
describe("TRIPWIRE: generic relation doors reject the whole exposure set", () => {
  const SRC = "00000000-0000-4000-8000-0000000000c1";
  const DST = "00000000-0000-4000-8000-0000000000c2";

  it("derives a non-vacuous exposure set to test", () => {
    expect(EXPOSURE_RELATION_TYPES.length).toBeGreaterThanOrEqual(2);
    // The member the old guards missed. If it is ever removed from the
    // whitelist, this test must be re-read, not silently satisfied.
    expect(EXPOSURE_RELATION_TYPES).toContain("belongs_to_project");
    expect(EXPOSURE_RELATION_TYPES).toContain("visible_to");
  });

  for (const type of EXPOSURE_RELATION_TYPES) {
    it(`relations.create refuses \`${type}\` before any DB work`, async () => {
      await expect(
        caller.create({
          sourceEntityId: SRC,
          targetEntityId: DST,
          type,
        })
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("is an exposure edge"),
      });
      // Refused on TYPE alone — no endpoint resolution, no permission ladder.
      expect(mockCheckPermission).not.toHaveBeenCalled();
    });

    it(`relations.batchCreate refuses \`${type}\` before any DB work`, async () => {
      await expect(
        caller.batchCreate({
          relations: [{ sourceEntityId: SRC, targetEntityId: DST, type }],
        })
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("is an exposure edge"),
      });
      // The guard runs BEFORE the workspace-header check, so this cannot pass
      // by accidentally hitting the `workspaceId is required` BAD_REQUEST.
      expect(mockCheckPermission).not.toHaveBeenCalled();
    });
  }

  it("names the sanctioned writer for each refused edge", async () => {
    await expect(
      caller.create({
        sourceEntityId: SRC,
        targetEntityId: DST,
        type: "visible_to",
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining("relations.exposeToAnchor"),
    });
    await expect(
      caller.create({
        sourceEntityId: SRC,
        targetEntityId: DST,
        type: "belongs_to_project",
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining("linkEntityToProject"),
    });
  });

  it("a NON-exposure relation type is not caught by the widened guard", async () => {
    // The widening must reject the exposure SET, not "every relation type".
    // `mentions` gets past the guard and fails later on real DB work — any
    // failure that is NOT the FORBIDDEN exposure refusal proves the guard let
    // it through.
    await expect(
      caller.create({
        sourceEntityId: SRC,
        targetEntityId: DST,
        type: "mentions",
      })
    ).rejects.not.toMatchObject({
      message: expect.stringContaining("is an exposure edge"),
    });
  });
});
