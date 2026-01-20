import { describe, it, expect, vi, beforeEach } from "vitest";
import { initTRPC } from "@trpc/server";
import { apiKeyMiddleware, createScopedProcedure } from "./api-key-auth.js";
import { apiKeyService } from "../services/api-keys.js";
import { type Context } from "../context.js";

// Mock apiKeyService
vi.mock("../services/api-keys.js", () => ({
  apiKeyService: {
    validateApiKey: vi.fn(),
    checkRateLimit: vi.fn(),
  },
}));

// Setup tRPC for testing
const t = initTRPC.context<Context>().create();

// Create a test router using the middleware
const createTestRouter = () => {
  const protectedProc = t.procedure.use(apiKeyMiddleware);
  const scopedProc = (scopes: string[]) =>
    protectedProc.use(createScopedProcedure(scopes));

  return t.router({
    testProtected: protectedProc.query(({ ctx }) => {
      return {
        userId: ctx.userId,
        scopes: ctx.scopes,
        apiKeyId: ctx.apiKeyId,
      };
    }),
    testScoped: scopedProc(["read:entities"]).query(() => {
      return { success: true };
    }),
  });
};

describe("API Key Middleware", () => {
  let mockCtx: any;

  beforeEach(() => {
    mockCtx = {
      req: {
        headers: new Map(),
      },
    };
    vi.clearAllMocks();
  });

  it("should throw UNAUTHORIZED if no API key provided", async () => {
    const router = createTestRouter();
    const caller = router.createCaller(mockCtx);

    await expect(caller.testProtected()).rejects.toThrow("API key required");
  });

  it("should throw UNAUTHORIZED if API key is invalid", async () => {
    mockCtx.req.headers.set("authorization", "Bearer invalid-key");
    vi.mocked(apiKeyService.validateApiKey).mockResolvedValue(null);

    const router = createTestRouter();
    const caller = router.createCaller(mockCtx);

    await expect(caller.testProtected()).rejects.toThrow(
      "Invalid or expired API key"
    );
  });

  it("should throw TOO_MANY_REQUESTS if rate limit exceeded", async () => {
    mockCtx.req.headers.set("authorization", "Bearer valid-key");
    vi.mocked(apiKeyService.validateApiKey).mockResolvedValue({
      id: "key-123",
      userId: "user-123",
      keyName: "Test Key",
      scope: ["read:entities"],
      isActive: true,
    } as any);

    vi.mocked(apiKeyService.checkRateLimit).mockReturnValue(false);

    const router = createTestRouter();
    const caller = router.createCaller(mockCtx);

    await expect(caller.testProtected()).rejects.toThrow("Rate limit exceeded");
  });

  it("should add auth context if key is valid", async () => {
    mockCtx.req.headers.set("authorization", "Bearer valid-key");
    vi.mocked(apiKeyService.validateApiKey).mockResolvedValue({
      id: "key-123",
      userId: "user-123",
      keyName: "Test Key",
      scope: ["read:entities"],
      isActive: true,
    } as any);

    vi.mocked(apiKeyService.checkRateLimit).mockReturnValue(true);

    const router = createTestRouter();
    const caller = router.createCaller(mockCtx);

    const result = await caller.testProtected();

    expect(result.userId).toBe("user-123");
    expect(result.apiKeyId).toBe("key-123");
    expect(result.scopes).toEqual(["read:entities"]);
  });

  it("should allow access if required scope is present", async () => {
    mockCtx.req.headers.set("authorization", "Bearer valid-key");
    vi.mocked(apiKeyService.validateApiKey).mockResolvedValue({
      id: "key-123",
      userId: "user-123",
      keyName: "Test Key",
      scope: ["read:entities", "write:entities"],
      isActive: true,
    } as any);
    vi.mocked(apiKeyService.checkRateLimit).mockReturnValue(true);

    const router = createTestRouter();
    const caller = router.createCaller(mockCtx);

    const result = await caller.testScoped();
    expect(result.success).toBe(true);
  });

  it("should deny access if required scope is missing", async () => {
    mockCtx.req.headers.set("authorization", "Bearer valid-key");
    vi.mocked(apiKeyService.validateApiKey).mockResolvedValue({
      id: "key-123",
      userId: "user-123",
      keyName: "Test Key",
      scope: ["write:entities"], // Missing read:entities
      isActive: true,
    } as any);
    vi.mocked(apiKeyService.checkRateLimit).mockReturnValue(true);

    const router = createTestRouter();
    const caller = router.createCaller(mockCtx);

    await expect(caller.testScoped()).rejects.toThrow(
      "Insufficient permissions"
    );
  });
});
