import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context.js";

const h = vi.hoisted(() => ({
  checkPermissionOrPropose: vi.fn(),
  setProfileRenderer: vi.fn(),
}));

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
}));

vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: h.checkPermissionOrPropose,
}));

vi.mock("../services/profiles/set-profile-renderer.js", () => ({
  setProfileRenderer: h.setProfileRenderer,
}));

vi.mock("@synap/database", async (importOriginal) => {
  // PARTIAL mock (`importOriginal` + spread), deliberately — see
  // auth.test.ts for the incident this pattern fixes: a TOTAL replacement
  // breaks the moment ANY module in the import graph reaches for an export
  // the object does not list (e.g. "No \"isNull\" export is defined on the
  // @synap/database mock"), because a new source import elsewhere in the
  // graph pulls in a drizzle helper this suite never mentions. Spreading the
  // real module makes the stub additive — only `db` and the handful of
  // repository/service symbols this test touches are faked.
  const actual = await importOriginal<typeof import("@synap/database")>();

  return {
    ...actual,
    db: {
      query: {
        workspaceMembers: {
          findFirst: vi.fn(async () => ({ role: "owner" })),
        },
        workspaces: {
          findFirst: vi.fn(async () => ({ archivedAt: null })),
        },
      },
    },
    getDb: vi.fn(async () => ({})),
    ProfileRepository: class {},
    ProfilePropertyRepository: class {},
    ProfileResolutionService: class {},
    ViewRepository: class {},
    WorkspaceRepository: class {},
    eventRepository: {},
  };
});

import { profilesRouter } from "./profiles.js";

const rendererRef = {
  kind: "cell" as const,
  cellKey: "contact-card",
  props: {},
};

function callerContext(overrides: Partial<Context> = {}): Context {
  return {
    db: {},
    authenticated: true,
    userId: "user-1",
    workspaceId: "workspace-1",
    ...overrides,
  };
}

describe("profiles.setProfileRendererOverride governance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.checkPermissionOrPropose.mockResolvedValue({ granted: true });
    h.setProfileRenderer.mockResolvedValue(undefined);
  });

  it("applies an authorized operator write through the shared service", async () => {
    const caller = profilesRouter.createCaller(callerContext());

    const result = await caller.setProfileRendererOverride({
      profileSlug: "contact",
      contentKind: "entity-detail",
      ref: rendererRef,
    });

    expect(h.checkPermissionOrPropose).toHaveBeenCalledWith({
      userId: "user-1",
      agentUserId: undefined,
      workspaceId: "workspace-1",
      subjectType: "profile",
      action: "renderer.set",
      source: undefined,
      sourceMessageId: undefined,
      sessionId: undefined,
      projectId: undefined,
      data: {
        profileSlug: "contact",
        slot: "detail",
        scope: "workspace",
        ref: rendererRef,
      },
    });
    expect(h.setProfileRenderer).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "workspace-1",
      profileSlug: "contact",
      slot: "detail",
      ref: rendererRef,
      scope: "workspace",
    });
    expect(result).toEqual({
      success: true,
      status: "applied",
      proposalId: null,
    });
  });

  it("returns a reviewable proposal without applying an agent write", async () => {
    h.checkPermissionOrPropose.mockResolvedValueOnce({
      granted: false,
      proposalId: "proposal-1",
      proposalType: "profile.renderer.set",
      summary: "Set renderer for contact",
      reasoning: "AI-generated renderer promotion",
      reviewPath: "/open/proposal-1",
      reviewUrl: "https://synap.test/open/proposal-1",
    });
    const caller = profilesRouter.createCaller(
      callerContext({
        agentUserId: "agent-1",
        source: "intelligence",
        sourceMessageId: "message-1",
        sessionId: "session-1",
        projectId: "project-1",
      })
    );

    const result = await caller.setProfileRendererOverride({
      profileSlug: "contact",
      contentKind: "entity-detail",
      ref: rendererRef,
    });

    expect(h.checkPermissionOrPropose).toHaveBeenCalledWith(
      expect.objectContaining({
        agentUserId: "agent-1",
        source: "intelligence",
        sourceMessageId: "message-1",
        sessionId: "session-1",
        projectId: "project-1",
      })
    );
    expect(h.setProfileRenderer).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      status: "proposed",
      proposalId: "proposal-1",
    });
  });

  it("preserves clearing an override through the shared service", async () => {
    const caller = profilesRouter.createCaller(callerContext());

    await caller.setProfileRendererOverride({
      profileSlug: "contact",
      contentKind: "collection",
      ref: null,
    });

    expect(h.setProfileRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: "list",
        ref: null,
      })
    );
  });
});
