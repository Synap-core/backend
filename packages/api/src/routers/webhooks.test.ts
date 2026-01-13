import { describe, it, expect, vi, beforeEach } from "vitest";
import { webhooksRouter } from "./webhooks.js";

// Mock dependencies
vi.mock("@synap/database", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(),
    })),
    query: {
      webhookSubscriptions: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
      },
    },
    update: vi.fn(() => ({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn(),
    })),
    delete: vi.fn(() => ({
      where: vi.fn().mockReturnThis(),
      returning: vi.fn(),
    })),
  },
  webhookSubscriptions: {
    id: "id",
    userId: "user_id",
    createdAt: "created_at",
  },
  eq: vi.fn(),
  and: vi.fn(),
}));

describe("Webhooks Router", () => {
  let mockCtx: any;

  beforeEach(() => {
    mockCtx = {
      userId: "user-123",
      authenticated: true,
    };
    vi.clearAllMocks();
  });

  describe("create", () => {
    it("should create a webhook subscription", async () => {
      const { db } = await import("@synap/database");
      const mockSubscription = {
        id: "sub-123",
        userId: "user-123",
        name: "Test Webhook",
        url: "https://example.com/webhook",
        eventTypes: ["task.created"],
        secret: "generated-secret",
        active: true,
      };

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([mockSubscription]),
        }),
      } as any);

      const caller = webhooksRouter.createCaller(mockCtx);
      const result = await caller.create({
        name: "Test Webhook",
        url: "https://example.com/webhook",
        eventTypes: ["task.created"],
      });

      expect(result.subscription).toEqual(mockSubscription);
      expect(result.secret).toBeDefined();
      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("should list user subscriptions without secrets", async () => {
      const { db } = await import("@synap/database");
      const mockSubscriptions = [
        {
          id: "sub-1",
          userId: "user-123",
          name: "Webhook 1",
          secret: "secret-1", // Should be removed
          url: "https://example.com/1",
        },
        {
          id: "sub-2",
          userId: "user-123",
          name: "Webhook 2",
          secret: "secret-2", // Should be removed
          url: "https://example.com/2",
        },
      ];

      vi.mocked(db.query.webhookSubscriptions.findMany).mockResolvedValue(
        mockSubscriptions as any,
      );

      const caller = webhooksRouter.createCaller(mockCtx);
      const result = await caller.list();

      expect(result).toHaveLength(2);
      expect(result[0]).not.toHaveProperty("secret");
      expect(result[1]).not.toHaveProperty("secret");
      expect(result[0].id).toBe("sub-1");
    });
  });

  describe("update", () => {
    it("should update subscription if owned by user", async () => {
      const { db } = await import("@synap/database");

      // Mock finding existing
      vi.mocked(db.query.webhookSubscriptions.findFirst).mockResolvedValue({
        id: "sub-1",
        userId: "user-123",
      } as any);

      // Mock update
      const updatedSub = {
        id: "sub-1",
        userId: "user-123",
        name: "Updated Name",
        secret: "secret",
      };

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedSub]),
          }),
        }),
      } as any);

      const caller = webhooksRouter.createCaller(mockCtx);
      const result = await caller.update({
        id: "sub-1",
        name: "Updated Name",
      });

      expect(result.name).toBe("Updated Name");
      expect(result).not.toHaveProperty("secret");
    });

    it("should throw NOT_FOUND if subscription does not exist or not owned", async () => {
      const { db } = await import("@synap/database");
      vi.mocked(db.query.webhookSubscriptions.findFirst).mockResolvedValue(
        undefined,
      );

      const caller = webhooksRouter.createCaller(mockCtx);

      await expect(
        caller.update({
          id: "sub-1",
          name: "Updated Name",
        }),
      ).rejects.toThrow("Webhook subscription not found");
    });
  });

  describe("delete", () => {
    it("should delete subscription", async () => {
      const { db } = await import("@synap/database");

      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "sub-1" }]),
        }),
      } as any);

      const caller = webhooksRouter.createCaller(mockCtx);
      const result = await caller.delete({ id: "sub-1" });

      expect(result.success).toBe(true);
    });

    it("should throw NOT_FOUND if delete returns no rows", async () => {
      const { db } = await import("@synap/database");

      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const caller = webhooksRouter.createCaller(mockCtx);

      await expect(caller.delete({ id: "sub-1" })).rejects.toThrow(
        "Webhook subscription not found",
      );
    });
  });
});
