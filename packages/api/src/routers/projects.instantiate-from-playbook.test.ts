/**
 * `projects.instantiateFromPlaybook` — since tracks (0272), a THIN WRAPPER over
 * `startTrack` (services/tracks), the one door a method starts on a project.
 *
 * Pinned here:
 *   · it delegates to `startTrack` with the caller's identity (agent included),
 *     so governance, the scope refusal and both visibility floors have ONE
 *     authority (their behaviour is proven against the real service in
 *     `services/tracks/__tests__/tracks.pglite.test.ts`);
 *   · it writes NOTHING itself — not `settings.stages`, not `phase`: the
 *     proto-track's copy-onto-the-project mechanism is gone;
 *   · the old result keys survive for existing callers, now describing the
 *     track (`phaseSeeded` is always false; an existing phase is kept);
 *   · a proposed start is relayed as `{ status: "proposed", proposalId }`.
 *
 * DB is mocked. The `@synap/database` mock is PARTIAL (`importOriginal` +
 * spread) on purpose: a total replacement silently kills the module the first
 * time the source file imports a new symbol, and typecheck stays green.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetDb, mockRepoUpdate, mockStartTrack } = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockRepoUpdate: vi.fn(),
  mockStartTrack: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: { query: {} },
    getDb: mockGetDb,
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

vi.mock("../services/tracks/tracks-service.js", () => ({
  startTrack: mockStartTrack,
}));

import { projectsRouter } from "./projects.js";

const PROJECT_ID = "00000000-0000-4000-8000-0000000000b1";
const PLAYBOOK_ID = "00000000-0000-4000-8000-0000000000a1";
const TRACK_ID = "00000000-0000-4000-8000-0000000000c1";
const USER_ID = "user-1";

function setProject(row: Record<string, unknown> | undefined) {
  mockGetDb.mockResolvedValue({
    query: { projects: { findFirst: async () => row } },
  });
}

function caller(extra: Record<string, unknown> = {}) {
  return projectsRouter.createCaller({
    authenticated: true,
    userId: USER_ID,
    ...extra,
  } as never);
}

function started(status: "started" | "exists" = "started") {
  return {
    status,
    track: {
      id: TRACK_ID,
      definitionSnapshot: {
        stages: [
          { key: "discovery", name: "Discovery" },
          { key: "build", name: "Build" },
        ],
      },
    },
    playbook: { id: PLAYBOOK_ID, name: "Client Engagement", version: 4 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStartTrack.mockResolvedValue(started());
  setProject({
    id: PROJECT_ID,
    workspaceId: "ws-1",
    userId: USER_ID,
    phase: null,
    settings: {},
  });
});

describe("instantiateFromPlaybook — a wrapper over startTrack", () => {
  it("delegates with both ids and the caller's identity", async () => {
    await caller({
      agentUserId: "agent-1",
      isHubProtocol: true,
    }).instantiateFromPlaybook({
      projectId: PROJECT_ID,
      playbookId: PLAYBOOK_ID,
    });
    expect(mockStartTrack).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      playbookId: PLAYBOOK_ID,
      actor: { userId: USER_ID, agentUserId: "agent-1", isHubProtocol: true },
    });
  });

  it("writes NOTHING onto the project — no settings.stages, no phase", async () => {
    const result = await caller().instantiateFromPlaybook({
      projectId: PROJECT_ID,
      playbookId: PLAYBOOK_ID,
    });
    expect(mockRepoUpdate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "instantiated",
      trackId: TRACK_ID,
      trackStatus: "started",
      playbookId: PLAYBOOK_ID,
      playbookVersion: 4,
      stageCount: 2,
      phase: null,
      phaseSeeded: false,
      phaseKept: false,
    });
  });

  it("keeps an existing phase and says so", async () => {
    setProject({
      id: PROJECT_ID,
      workspaceId: null,
      userId: USER_ID,
      phase: "in the weeds",
      settings: null,
    });
    mockStartTrack.mockResolvedValue(started("exists"));
    const result = await caller().instantiateFromPlaybook({
      projectId: PROJECT_ID,
      playbookId: PLAYBOOK_ID,
    });
    expect(result).toMatchObject({
      phase: "in the weeds",
      phaseSeeded: false,
      phaseKept: true,
      trackStatus: "exists",
    });
  });

  it("relays a proposed start and writes nothing", async () => {
    mockStartTrack.mockResolvedValue({
      status: "proposed",
      proposalId: "prop-1",
      proposalType: "track.create",
      message: "m",
      reviewUrl: "u",
    });
    const result = await caller().instantiateFromPlaybook({
      projectId: PROJECT_ID,
      playbookId: PLAYBOOK_ID,
    });
    expect(result).toEqual({ status: "proposed", proposalId: "prop-1" });
    expect(mockRepoUpdate).not.toHaveBeenCalled();
  });

  it("404s when the project is not visible, before any track work", async () => {
    setProject(undefined);
    await expect(
      caller().instantiateFromPlaybook({
        projectId: PROJECT_ID,
        playbookId: PLAYBOOK_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mockStartTrack).not.toHaveBeenCalled();
  });
});
