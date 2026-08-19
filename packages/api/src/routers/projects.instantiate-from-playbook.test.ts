/**
 * `projects.instantiateFromPlaybook` — the write door that binds a project to a
 * PROJECT-SCOPED playbook.
 *
 * Pinned here (the pure deep-copy proof lives in
 * `projects.playbook-binding.test.ts`):
 *   · a SESSION-scoped playbook is REJECTED — a session template must not
 *     become a project's stage vocabulary;
 *   · an EXISTING phase is never overwritten, and the result says so;
 *   · the `project --instantiated_from--> playbook` edge is written through the
 *     same `createLinks` door `playbook-lifecycle.ts` uses;
 *   · `settings` is MERGED, so a project's other settings survive;
 *   · a `{ status: "proposed" }` gate answer writes NOTHING.
 *
 * DB is mocked (no live Postgres in CI); assertions are on the writes issued.
 * The `@synap/database` mock is PARTIAL (`importOriginal` + spread) on purpose:
 * a total replacement silently kills the module the first time the source file
 * imports a new symbol, and typecheck stays green.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybookStage } from "@synap/playbooks";

const {
  mockGetDb,
  mockRepoUpdate,
  mockCreateLinks,
  mockCheckPermission,
  mockScopedFindFirst,
} = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockRepoUpdate: vi.fn(),
  mockCreateLinks: vi.fn(),
  mockCheckPermission: vi.fn(),
  mockScopedFindFirst: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: { query: {} },
    getDb: mockGetDb,
    eq: vi.fn((column, value) => ({ eq: [column, value] })),
    and: vi.fn((...c) => ({ and: c.filter(Boolean) })),
    or: vi.fn((...c) => ({ or: c.filter(Boolean) })),
    EventRepository: class {},
    ProjectRepository: class {
      update = mockRepoUpdate;
    },
  };
});

// Mutations run the read-only guard first, which hits the eager `db` singleton.
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

vi.mock("../access/index.js", () => ({
  AccessContext: { from: (ctx: unknown) => ({ __access: ctx }) },
  scopedDb: () => ({ findFirst: mockScopedFindFirst }),
}));

vi.mock("../services/links/links-service.js", () => ({
  createLinks: mockCreateLinks,
}));

vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: mockCheckPermission,
}));

vi.mock("../utils/audit-log.js", () => ({ auditLog: () => {} }));
vi.mock("@synap/events", () => ({ emitSideEffects: () => {} }));

import { projectsRouter } from "./projects.js";

const PROJECT_ID = "00000000-0000-4000-8000-0000000000b1";
const PLAYBOOK_ID = "00000000-0000-4000-8000-0000000000a1";
const USER_ID = "user-1";

function stages(): PlaybookStage[] {
  return [
    { key: "discovery", name: "Discovery", category: "planned" },
    { key: "build", name: "Build", category: "started" },
  ];
}

function setProject(row: Record<string, unknown> | undefined) {
  mockGetDb.mockResolvedValue({
    query: { projects: { findFirst: async () => row } },
  });
}

function caller() {
  return projectsRouter.createCaller({
    authenticated: true,
    userId: USER_ID,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckPermission.mockResolvedValue({ granted: true });
  mockRepoUpdate.mockResolvedValue({ id: PROJECT_ID });
  mockCreateLinks.mockResolvedValue([]);
  mockScopedFindFirst.mockResolvedValue({
    id: PLAYBOOK_ID,
    name: "Client Engagement",
    version: 4,
    scope: "project",
    stages: stages(),
  });
  setProject({
    id: PROJECT_ID,
    workspaceId: "ws-1",
    userId: USER_ID,
    phase: null,
    settings: { agentPreferences: { tone: "brief" } },
  });
});

describe("instantiateFromPlaybook — scope floor", () => {
  it("REJECTS a session-scoped playbook", async () => {
    mockScopedFindFirst.mockResolvedValue({
      id: PLAYBOOK_ID,
      name: "Weekly Review",
      version: 1,
      scope: "session",
      stages: stages(),
    });

    await expect(
      caller().instantiateFromPlaybook({
        projectId: PROJECT_ID,
        playbookId: PLAYBOOK_ID,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mockRepoUpdate).not.toHaveBeenCalled();
    expect(mockCreateLinks).not.toHaveBeenCalled();
  });

  it("404s when the project is not visible to the caller", async () => {
    setProject(undefined);
    await expect(
      caller().instantiateFromPlaybook({
        projectId: PROJECT_ID,
        playbookId: PLAYBOOK_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mockRepoUpdate).not.toHaveBeenCalled();
  });

  it("404s when the playbook is not visible to the caller", async () => {
    mockScopedFindFirst.mockResolvedValue(undefined);
    await expect(
      caller().instantiateFromPlaybook({
        projectId: PROJECT_ID,
        playbookId: PLAYBOOK_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mockRepoUpdate).not.toHaveBeenCalled();
  });
});

describe("instantiateFromPlaybook — the write", () => {
  it("copies the stages, merges settings, seeds the phase and writes the edge", async () => {
    const result = await caller().instantiateFromPlaybook({
      projectId: PROJECT_ID,
      playbookId: PLAYBOOK_ID,
    });

    expect(result).toMatchObject({
      status: "instantiated",
      playbookId: PLAYBOOK_ID,
      playbookVersion: 4,
      stageCount: 2,
      phase: "discovery",
      phaseSeeded: true,
      phaseKept: false,
    });

    const [, patch, actingUserId] = mockRepoUpdate.mock.calls[0];
    expect(actingUserId).toBe(USER_ID);
    const written = patch.settings as Record<string, unknown>;
    // MERGED — the pre-existing key survives.
    expect(written.agentPreferences).toEqual({ tone: "brief" });
    expect(written.sourcePlaybookId).toBe(PLAYBOOK_ID);
    expect(written.sourcePlaybookVersion).toBe(4);
    expect((written.stages as PlaybookStage[]).map((s) => s.key)).toEqual([
      "discovery",
      "build",
    ]);
    expect(patch.phase).toBe("discovery");

    // The provenance edge, in the exact shape playbook-lifecycle.ts writes for
    // a session — scoped to the PROJECT's workspace, not the caller's lens.
    expect(mockCreateLinks).toHaveBeenCalledWith([
      {
        workspaceId: "ws-1",
        fromType: "project",
        fromId: PROJECT_ID,
        toType: "playbook",
        toId: PLAYBOOK_ID,
        linkType: "instantiated_from",
      },
    ]);
  });

  it("NEVER overwrites an existing phase — and reports that it kept it", async () => {
    setProject({
      id: PROJECT_ID,
      workspaceId: null,
      userId: USER_ID,
      phase: "in the weeds",
      settings: null,
    });

    const result = await caller().instantiateFromPlaybook({
      projectId: PROJECT_ID,
      playbookId: PLAYBOOK_ID,
    });

    expect(result).toMatchObject({
      phase: "in the weeds",
      phaseSeeded: false,
      phaseKept: true,
    });
    // `phase` is absent from the patch entirely — not set to the old value,
    // which would still be a write.
    const [, patch] = mockRepoUpdate.mock.calls[0];
    expect("phase" in patch).toBe(false);
    // Pod-personal project: the edge carries a NULL workspace.
    expect(mockCreateLinks.mock.calls[0][0][0].workspaceId).toBeNull();
  });

  it("gates on the PROJECT's workspace and carries both ids into the proposal", async () => {
    mockCheckPermission.mockResolvedValue({ proposalId: "prop-1" });

    const result = await caller().instantiateFromPlaybook({
      projectId: PROJECT_ID,
      playbookId: PLAYBOOK_ID,
    });

    expect(result).toEqual({ status: "proposed", proposalId: "prop-1" });
    expect(mockCheckPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        subjectType: "project",
        action: "instantiate_from_playbook",
        // Everything the executor needs — not just `{ id }`.
        data: { id: PROJECT_ID, playbookId: PLAYBOOK_ID },
      })
    );
    // A proposed gate writes NOTHING.
    expect(mockRepoUpdate).not.toHaveBeenCalled();
    expect(mockCreateLinks).not.toHaveBeenCalled();
  });
});
