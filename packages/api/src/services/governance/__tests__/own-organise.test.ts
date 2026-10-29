/**
 * FB1020 B3 — the door-side proofs (`own-organise.ts`). The freshness read
 * itself (`isOwnFreshWork`) is driven on real rows in
 * `projects.file-entities.pglite.test.ts`; here, the rules each door adds
 * around it, with `isOwnFreshWork` answering "yes" so every `false` below is
 * the door's own rule:
 *   - closing: only the `task` kind, only a `done` option, never a role, never
 *     without a key;
 *   - session filing: a project, or a goal of it (D1) only through a door
 *     that can undo it and only when no `uses` stamp is written; never an
 *     unfile or a space move; only the project the agent was told to focus on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  key: "key-1" as string | undefined,
  focus: "proj-named" as string | null,
  fresh: vi.fn(async () => true),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {},
  getRequestApiKeyId: () => h.key,
  isOwnFreshWork: h.fresh,
}));
vi.mock("../../agent-identity-service.js", () => ({
  getAgentFocusProjectId: async () => h.focus,
}));

import {
  ownWorkOrganiseForSessionFiling,
  ownWorkOrganiseForTaskClose,
} from "../own-organise.js";

const LIFECYCLE = {
  propertySlug: "status",
  propertyDefId: "d",
  declaredOnProfileId: "p",
  unclassified: [],
  options: [
    { key: "todo", category: "open" },
    { key: "done", category: "done" },
    { key: "cancelled", category: "lost" },
  ],
} as never;
const task = (over: Record<string, unknown> = {}) => ({
  entityId: "e1",
  entityType: "task",
  role: null,
  lifecycle: LIFECYCLE,
  ...over,
});

beforeEach(() => {
  h.key = "key-1";
  h.focus = "proj-named";
  h.fresh.mockClear();
});

describe("ownWorkOrganiseForTaskClose", () => {
  it("its own task into `done` → proven (and the freshness read is asked)", async () => {
    expect(
      await ownWorkOrganiseForTaskClose({
        agentUserId: "a1",
        target: task(),
        to: "done",
      })
    ).toBe(true);
    expect(h.fresh).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        agentUserId: "a1",
        apiKeyId: "key-1",
        subjectType: "entity",
        subjectIds: ["e1"],
      })
    );
  });

  it("a `lost` option, another kind, a role, no key → never proven", async () => {
    // `withKey: false` = no request key. (A defaulted `key` parameter could
    // never be unset: passing `undefined` re-applies the default.)
    const no = async (
      over: Record<string, unknown>,
      to = "done",
      withKey = true
    ) => {
      h.key = withKey ? "key-1" : undefined;
      return ownWorkOrganiseForTaskClose({
        agentUserId: "a1",
        target: task(over),
        to,
      });
    };
    expect(await no({}, "cancelled")).toBe(false);
    expect(await no({ entityType: "deal" })).toBe(false);
    expect(await no({ role: "lead" })).toBe(false);
    expect(await no({}, "done", false)).toBe(false);
  });
});

describe("ownWorkOrganiseForSessionFiling", () => {
  const file = (filing: Record<string, unknown>) =>
    ownWorkOrganiseForSessionFiling({
      agentUserId: "a1",
      sessionId: "s1",
      filing,
    });

  it("into the project it was told to focus on → proven", async () => {
    expect(await file({ projectId: "proj-named" })).toBe(true);
    expect(h.fresh).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        subjectType: "focus_session",
        subjectIds: ["s1"],
      })
    );
  });

  it("another project, an unfile, a space move or a track filing → never", async () => {
    expect(await file({ projectId: "proj-other" })).toBe(false);
    expect(await file({ projectId: null })).toBe(false);
    expect(await file({ projectId: "proj-named", workspaceId: "w2" })).toBe(
      false
    );
    expect(
      await file({
        projectId: "proj-named",
        trackFiling: {
          set: { trackId: "track-1" },
          trackProjectId: "proj-named",
          projectWorkspaceId: null,
        },
      })
    ).toBe(false);
  });
});

describe("ownWorkOrganiseForSessionFiling — a goal filing (D1)", () => {
  type Goal = {
    set: { trackId: string | null };
    trackProjectId: string | null;
    projectWorkspaceId: string | null;
  };
  const goal = (over: Partial<Goal> = {}): Goal => ({
    set: { trackId: "track-1" },
    trackProjectId: "proj-named",
    projectWorkspaceId: "ws-home",
    ...over,
  });
  const fileGoal = (
    over: {
      trackFiling?: Goal;
      projectId?: string | null;
      workspaceId?: string | null;
      sessionWorkspaceId?: string | null;
      goalFilingUndo?: boolean;
    } = {}
  ) =>
    ownWorkOrganiseForSessionFiling({
      agentUserId: "a1",
      sessionId: "s1",
      sessionWorkspaceId:
        "sessionWorkspaceId" in over ? over.sessionWorkspaceId : "ws-home",
      goalFilingUndo: over.goalFilingUndo ?? true,
      filing: {
        trackFiling: over.trackFiling ?? goal(),
        ...("projectId" in over ? { projectId: over.projectId } : {}),
        ...("workspaceId" in over ? { workspaceId: over.workspaceId } : {}),
      },
    });

  it("a goal of the focus project, the session in its home space or in none → proven", async () => {
    expect(await fileGoal()).toBe(true);
    expect(h.fresh).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        subjectType: "focus_session",
        subjectIds: ["s1"],
      })
    );
    expect(await fileGoal({ sessionWorkspaceId: null })).toBe(true);
    expect(await fileGoal({ projectId: "proj-named" })).toBe(true);
  });

  it("a session in another space (the filing stamps `uses`, no Undo for it) → never", async () => {
    expect(await fileGoal({ sessionWorkspaceId: "ws-other" })).toBe(false);
  });

  it("a goal of another project, an unfile, a space move, a door with no Undo → never", async () => {
    expect(
      await fileGoal({ trackFiling: goal({ trackProjectId: "proj-other" }) })
    ).toBe(false);
    expect(
      await fileGoal({ trackFiling: goal({ set: { trackId: null } }) })
    ).toBe(false);
    expect(await fileGoal({ workspaceId: "ws-home" })).toBe(false);
    expect(await fileGoal({ projectId: "proj-other" })).toBe(false);
    expect(await fileGoal({ goalFilingUndo: false })).toBe(false);
  });

  it("not fresh (a person touched it, or > 24 h) → never", async () => {
    h.fresh.mockResolvedValueOnce(false);
    expect(await fileGoal()).toBe(false);
  });
});
