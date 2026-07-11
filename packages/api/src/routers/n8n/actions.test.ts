import { describe, it, expect, vi, beforeEach } from "vitest";
import { n8nActionsRouter } from "./actions.js";

// Hoisted so the vi.mock factories below can reference them (vi.mock is hoisted
// above imports; a plain outer const would be in the TDZ inside the factory).
const { mockCreate, mockCreateCaller } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  return {
    mockCreate,
    mockCreateCaller: vi.fn(() => ({ create: mockCreate })),
  };
});

// Mock dependencies. createEntity now routes through the governed entities.create
// door (createHubProtocolCallerContext → entitiesRouter.createCaller().create)
// instead of a raw event insert, so mock that door — not `db.insert`.
vi.mock("@synap/database", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ workspaceId: "ws-1" }]),
        })),
      })),
    })),
  },
  workspaceMembers: { userId: "user_id", workspaceId: "workspace_id" },
  eq: vi.fn(() => ({})),
  searchEntityVectorsRaw: vi.fn(),
}));

vi.mock("../entities.js", () => ({
  entitiesRouter: { createCaller: mockCreateCaller },
}));

vi.mock("../hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: vi
    .fn()
    .mockResolvedValue({ userId: "user-123" }),
}));

vi.mock("@synap/ai-embeddings", () => ({
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

describe("n8n Actions Router", () => {
  let mockCtx: any;

  beforeEach(() => {
    mockCtx = {
      userId: "user-123",
      authenticated: true,
      apiKeyId: "test-key-id",
      apiKeyName: "Test Key",
      scopes: ["write:entities", "read:entities", "ai:analyze"],
    };
    vi.clearAllMocks();
  });

  describe("createEntity", () => {
    it("routes create through the governed entities.create door", async () => {
      mockCreate.mockResolvedValue({
        status: "created",
        id: "ent-new",
        message: "note created successfully",
      });
      const caller = n8nActionsRouter.createCaller(mockCtx);

      const result = await caller.createEntity({
        type: "note",
        content: "Test content",
        title: "Test Title",
        tags: ["alpha"],
      });

      expect(result.success).toBe(true);
      expect(result.entityId).toBe("ent-new");
      // The governed door was called with the mapped fields + n8n provenance —
      // NOT a raw event insert (the bypass this rewrite removed).
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          profileSlug: "note",
          title: "Test Title",
          content: "Test content",
          source: "n8n",
          properties: expect.objectContaining({ tags: ["alpha"] }),
        })
      );
    });

    it("should require write:entities scope", async () => {
      mockCtx.scopes = ["read:entities"]; // Missing write scope
      const caller = n8nActionsRouter.createCaller(mockCtx);

      await expect(
        caller.createEntity({
          type: "note",
          content: "Test",
        })
      ).rejects.toThrow("Insufficient permissions");
    });
  });

  describe("searchEntities", () => {
    it("should return search results", async () => {
      const { searchEntityVectorsRaw } = await import("@synap/database");
      vi.mocked(searchEntityVectorsRaw).mockResolvedValue([
        {
          entityId: "ent-1",
          userId: "user-123",
          entityType: "note",
          title: "Result 1",
          preview: "Preview",
          fileUrl: null,
          relevanceScore: 0.9,
        },
      ]);

      const caller = n8nActionsRouter.createCaller(mockCtx);

      const result = await caller.searchEntities({
        query: "test query",
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].entityId).toBe("ent-1");
      expect(result.count).toBe(1);
    });

    it("should filter by type", async () => {
      const { searchEntityVectorsRaw } = await import("@synap/database");
      vi.mocked(searchEntityVectorsRaw).mockResolvedValue([
        { entityId: "1", entityType: "note", relevanceScore: 0.9 } as any,
        { entityId: "2", entityType: "task", relevanceScore: 0.8 } as any,
      ]);

      const caller = n8nActionsRouter.createCaller(mockCtx);

      const result = await caller.searchEntities({
        query: "test",
        type: "note",
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].type).toBe("note");
    });
  });

  describe("analyzeContent", () => {
    it("should perform requested analysis", async () => {
      const caller = n8nActionsRouter.createCaller(mockCtx);

      const result = await caller.analyzeContent({
        content: "This is a great test content with #tag\n- task item",
        analysisTypes: ["sentiment", "tags", "tasks"],
      });

      expect(result.success).toBe(true);
      expect(result.sentiment).toBe("positive");
      expect(result.tags).toContain("tag");
      expect(result.tasks).toHaveLength(1);
    });
  });
});
