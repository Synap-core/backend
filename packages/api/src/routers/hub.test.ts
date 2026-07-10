/**
 * Hub Protocol Router Tests
 *
 * Tests for the Hub Protocol router endpoints:
 * - generateAccessToken
 * - requestData
 * - submitInsight
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { hubRouter } from "./hub.js";
import { createContext } from "../context.js";
import type { HubInsight } from "@synap-core/hub-protocol";

// Mock dependencies
vi.mock("@synap/database", async () => {
  const drizzleOrm =
    await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");

  return {
    // Real drizzle-orm query builders/operators — hub.ts uses these to build
    // conditions (eq/and/desc/gte/lte); they don't touch a live DB.
    eq: drizzleOrm.eq,
    and: drizzleOrm.and,
    desc: drizzleOrm.desc,
    gte: drizzleOrm.gte,
    lte: drizzleOrm.lte,
    getDb: vi.fn(async () => ({})),
    getEventRepository: vi.fn(() => ({
      append: vi.fn(),
    })),
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => ({
                offset: vi.fn(() => Promise.resolve([])),
              })),
            })),
          })),
        })),
      })),
      // Used by the read-only-guard middleware (split-brain-service.ts) on
      // every protectedProcedure mutation.
      query: {
        syncGeneration: {
          findFirst: vi.fn(async () => ({
            id: "current",
            role: "primary",
            splitBrainDetected: false,
            generation: 0,
            lastPeerGeneration: 0,
            lastPeerContact: null,
          })),
        },
      },
    },
    entities: {
      id: "id",
      title: "title",
      preview: "preview",
      type: "type",
      createdAt: "createdAt",
      updatedAt: "updatedAt",
      userId: "userId",
    },
    syncGeneration: { id: "id" },
  };
});

vi.mock("./hub-utils.js", () => ({
  generateHubAccessToken: vi.fn(() => ({
    token: "mock-jwt-token",
    expiresAt: new Date(Date.now() + 300000),
  })),
  validateHubToken: vi.fn(() => ({
    userId: "test-user-123",
    requestId: "11111111-1111-4111-8111-111111111111",
    scope: ["preferences", "notes"],
    expiresAt: new Date(Date.now() + 300000),
  })),
  logHubAccess: vi.fn(),
}));

vi.mock("./hub-transform.js", () => ({
  transformInsightToEvents: vi.fn(() => [
    {
      type: "task.creation.requested",
      data: { title: "Test Task" },
      userId: "test-user-123",
    },
  ]),
}));

describe("Hub Router", () => {
  let ctx: Awaited<ReturnType<typeof createContext>>;

  beforeEach(async () => {
    ctx = await createContext(new Request("http://localhost:3000"));
    ctx.authenticated = true;
    ctx.userId = "test-user-123";
  });

  describe("generateAccessToken", () => {
    it("should generate a valid access token", async () => {
      const caller = hubRouter.createCaller(ctx);

      const result = await caller.generateAccessToken({
        requestId: "11111111-1111-4111-8111-111111111111",
        scope: ["preferences", "notes"],
        expiresIn: 300,
      });

      expect(result).toHaveProperty("token");
      expect(result).toHaveProperty("expiresAt");
      expect(result.token).toBe("mock-jwt-token");
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it("should validate scope", async () => {
      const caller = hubRouter.createCaller(ctx);

      await expect(
        caller.generateAccessToken({
          requestId: "11111111-1111-4111-8111-111111111111",
          scope: ["invalid-scope"] as any,
          expiresIn: 300,
        })
      ).rejects.toThrow();
    });

    it("should validate expiresIn range", async () => {
      const caller = hubRouter.createCaller(ctx);

      await expect(
        caller.generateAccessToken({
          requestId: "11111111-1111-4111-8111-111111111111",
          scope: ["preferences"],
          expiresIn: 50, // Too short
        })
      ).rejects.toThrow();

      await expect(
        caller.generateAccessToken({
          requestId: "11111111-1111-4111-8111-111111111111",
          scope: ["preferences"],
          expiresIn: 400, // Too long
        })
      ).rejects.toThrow();
    });

    it("should require authentication", async () => {
      ctx.authenticated = false;
      const caller = hubRouter.createCaller(ctx);

      await expect(
        caller.generateAccessToken({
          requestId: "11111111-1111-4111-8111-111111111111",
          scope: ["preferences"],
          expiresIn: 300,
        })
      ).rejects.toThrow(TRPCError);
    });
  });

  describe("requestData", () => {
    it("should return data for valid token and scope", async () => {
      const caller = hubRouter.createCaller(ctx);

      const result = await caller.requestData({
        token: "valid-token",
        scope: ["preferences", "notes"],
      });

      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("metadata");
      expect(result.metadata).toHaveProperty("recordCount");
    });

    it("should reject invalid token", async () => {
      const { validateHubToken } = await import("./hub-utils.js");
      vi.mocked(validateHubToken).mockImplementationOnce(() => {
        throw new Error("Invalid token");
      });

      const caller = hubRouter.createCaller(ctx);

      await expect(
        caller.requestData({
          token: "invalid-token",
          scope: ["preferences"],
        })
      ).rejects.toThrow();
    });

    it("should apply filters when provided", async () => {
      const caller = hubRouter.createCaller(ctx);

      const result = await caller.requestData({
        token: "valid-token",
        scope: ["notes"],
        filters: {
          limit: 10,
          dateRange: {
            start: "2025-01-01T00:00:00Z",
            end: "2025-01-31T23:59:59Z",
          },
        },
      });

      expect(result).toHaveProperty("data");
    });
  });

  describe("submitInsight", () => {
    const validInsight: HubInsight = {
      version: "1.0",
      type: "action_plan",
      correlationId: "11111111-1111-4111-8111-111111111111",
      actions: [
        {
          eventType: "task.creation.requested",
          data: {
            title: "Test Task",
            description: "Test Description",
          },
          requiresConfirmation: true,
          priority: 70,
        },
      ],
      confidence: 0.85,
      reasoning: "Test reasoning",
    };

    it("should accept valid insight", async () => {
      const caller = hubRouter.createCaller(ctx);

      const result = await caller.submitInsight({
        token: "valid-token",
        insight: validInsight,
      });

      expect(result).toHaveProperty("success");
      expect(result.success).toBe(true);
    });

    it("should reject invalid insight schema", async () => {
      const caller = hubRouter.createCaller(ctx);

      await expect(
        caller.submitInsight({
          token: "valid-token",
          insight: {
            version: "1.0",
            type: "invalid-type",
            correlationId: "test-123",
          } as any as HubInsight,
        })
      ).rejects.toThrow();
    });

    it("should transform insight to events", async () => {
      const { transformInsightToEvents } = await import("./hub-transform.js");
      const caller = hubRouter.createCaller(ctx);

      await caller.submitInsight({
        token: "valid-token",
        insight: validInsight,
      });

      expect(transformInsightToEvents).toHaveBeenCalledWith(
        validInsight,
        "test-user-123",
        expect.any(String)
      );
    });

    it("should reject invalid token", async () => {
      const { validateHubToken } = await import("./hub-utils.js");
      vi.mocked(validateHubToken).mockImplementationOnce(() => {
        throw new Error("Invalid token");
      });

      const caller = hubRouter.createCaller(ctx);

      await expect(
        caller.submitInsight({
          token: "invalid-token",
          insight: validInsight,
        })
      ).rejects.toThrow();
    });
  });
});
