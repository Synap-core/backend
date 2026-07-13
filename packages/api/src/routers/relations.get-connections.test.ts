import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAccessScopeWhere,
  mockChannelVisibilityWhere,
  mockDb,
  mockLoadFacetSlugsBatch,
  mockWorkspaceLensWhere,
} = vi.hoisted(() => ({
  mockAccessScopeWhere: vi.fn(() => ({ access: true })),
  mockChannelVisibilityWhere: vi.fn(() => ({ channel: true })),
  mockDb: {
    query: {
      relations: { findMany: vi.fn() },
      entities: { findMany: vi.fn() },
      channels: { findMany: vi.fn() },
      focusSessions: { findMany: vi.fn() },
    },
    select: vi.fn(),
  },
  mockLoadFacetSlugsBatch: vi.fn(),
  mockWorkspaceLensWhere: vi.fn(() => ({ workspace: true })),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: mockDb,
    and: vi.fn((...conditions) => ({ and: conditions })),
    or: vi.fn((...conditions) => ({ or: conditions })),
    eq: vi.fn((column, value) => ({ column, value })),
    isNull: vi.fn((column) => ({ isNull: column })),
    desc: vi.fn((column) => ({ desc: column })),
    inArray: vi.fn((column, values) => ({ column, values })),
    loadFacetSlugsBatch: mockLoadFacetSlugsBatch,
  };
});

vi.mock("../utils/project-scope.js", () => ({
  VISIBLE_TO: "visible_to",
  accessScopeWhere: mockAccessScopeWhere,
}));
vi.mock("../utils/channel-visibility.js", () => ({
  channelVisibilityWhere: mockChannelVisibilityWhere,
}));
vi.mock("../utils/user-visible-where.js", () => ({
  workspaceLensWhere: mockWorkspaceLensWhere,
}));
vi.mock("../utils/workspace-membership.js", () => ({
  resolveFacetVisibilityScope: vi.fn().mockResolvedValue({ userId: "user-1" }),
}));

import { relationsRouter } from "./relations.js";

const FOCUS = "00000000-0000-4000-8000-000000000001";
const OUTGOING = "00000000-0000-4000-8000-000000000002";
const INCOMING = "00000000-0000-4000-8000-000000000003";
const HIDDEN = "00000000-0000-4000-8000-000000000004";
const WORKSPACE = "00000000-0000-4000-8000-000000000010";

function selectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

describe("relations.getConnections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.query.relations.findMany.mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000020",
        sourceEntityId: FOCUS,
        targetEntityId: OUTGOING,
        type: "depends_on",
        createdAt: new Date("2026-01-01"),
      },
      {
        id: "00000000-0000-4000-8000-000000000021",
        sourceEntityId: FOCUS,
        targetEntityId: HIDDEN,
        type: "private_edge",
        createdAt: new Date("2026-01-02"),
      },
    ]);
    mockDb.query.entities.findMany.mockResolvedValue([
      {
        id: OUTGOING,
        title: "Visible outgoing",
        type: "task",
        workspaceId: WORKSPACE,
      },
      {
        id: INCOMING,
        title: "Visible incoming",
        type: "project",
        workspaceId: WORKSPACE,
      },
    ]);
    mockDb.query.channels.findMany.mockResolvedValue([]);
    mockDb.query.focusSessions.findMany.mockResolvedValue([]);
    mockLoadFacetSlugsBatch.mockResolvedValue(new Map());
    mockDb.select.mockImplementation((fields: Record<string, unknown>) =>
      selectChain(
        "targetEntityId" in fields
          ? [
              {
                sourceEntityId: FOCUS,
                targetEntityId: OUTGOING,
                propertySlug: "assignee",
                propertyUiHints: { label: "Assignee" },
              },
              {
                sourceEntityId: INCOMING,
                targetEntityId: FOCUS,
                propertySlug: "project",
                propertyUiHints: {},
              },
              {
                sourceEntityId: HIDDEN,
                targetEntityId: FOCUS,
                propertySlug: "private_link",
                propertyUiHints: {},
              },
            ]
          : []
      )
    );
  });

  it("returns relation ids, both structural directions, and only resolved neighbours", async () => {
    const caller = relationsRouter.createCaller({
      authenticated: true,
      userId: "user-1",
      workspaceId: WORKSPACE,
    } as never);

    const result = await caller.getConnections({
      entityId: FOCUS,
      workspaceId: WORKSPACE,
      limit: 50,
    });

    expect(result.connections).toEqual([
      expect.objectContaining({
        entityId: OUTGOING,
        relationId: "00000000-0000-4000-8000-000000000020",
        source: "graph",
      }),
      expect.objectContaining({
        entityId: OUTGOING,
        direction: "outgoing",
        source: "property",
        propertySlug: "assignee",
      }),
      expect.objectContaining({
        entityId: INCOMING,
        direction: "incoming",
        source: "property",
        propertySlug: "project",
      }),
    ]);
    expect(
      result.connections.map((connection) => connection.entityId)
    ).not.toContain(HIDDEN);
    expect(mockWorkspaceLensWhere).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      WORKSPACE
    );
    expect(mockAccessScopeWhere).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", workspaceLens: WORKSPACE })
    );
  });
});
