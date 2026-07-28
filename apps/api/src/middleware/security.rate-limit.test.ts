import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildRateLimitKey,
  classifyRateLimitPath,
  getRateLimitClassConfig,
  hashBearerToken,
  type RateLimitClass,
} from "./rate-limit-classes.js";

describe("classifyRateLimitPath", () => {
  const cases: Array<{ path: string; expected: RateLimitClass }> = [
    // free
    { path: "/health", expected: "free" },
    { path: "/metrics", expected: "free" },
    { path: "/api/hub/health", expected: "free" },
    { path: "/api/hub-protocol/health", expected: "free" },

    // import
    { path: "/api/hub/import", expected: "import" },
    { path: "/api/hub/import/analyze", expected: "import" },
    { path: "/api/hub/import/apply", expected: "import" },
    { path: "/api/hub/import/store-unit", expected: "import" },
    { path: "/api/hub-protocol/import/analyze", expected: "import" },

    // agent-turn (higher AI budget)
    {
      path: "/api/hub/discord/agent-turn",
      expected: "ai_agent_turn",
    },
    {
      path: "/api/hub-protocol/discord/agent-turn",
      expected: "ai_agent_turn",
    },

    // ai interactive
    { path: "/api/external/chat", expected: "ai_interactive" },
    { path: "/api/external/chat/stream", expected: "ai_interactive" },
    { path: "/api/external/chat/channels", expected: "ai_interactive" },
    { path: "/v1/chat", expected: "ai_interactive" },
    { path: "/v1/chat/completions", expected: "ai_interactive" },

    // crud (default)
    { path: "/api/hub/entities", expected: "crud" },
    { path: "/api/hub/knowledge/ask", expected: "crud" },
    { path: "/trpc/entities.list", expected: "crud" },
    { path: "/api/federation/exchange", expected: "crud" },
    { path: "/v1/models", expected: "crud" },
    { path: "/api/chat/stream", expected: "crud" },
    { path: "/", expected: "crud" },
  ];

  it.each(cases)("$path → $expected", ({ path, expected }) => {
    expect(classifyRateLimitPath(path)).toBe(expected);
  });

  it("strips query and hash before classifying", () => {
    expect(classifyRateLimitPath("/health?ready=1")).toBe("free");
    expect(classifyRateLimitPath("/api/hub/import/analyze?x=1")).toBe("import");
    expect(classifyRateLimitPath("/v1/chat/completions#frag")).toBe(
      "ai_interactive"
    );
  });

  it("does not treat nested health paths outside hub as free", () => {
    expect(classifyRateLimitPath("/api/webhooks/health")).toBe("crud");
  });

  it("does not classify non-import paths containing 'import'", () => {
    expect(
      classifyRateLimitPath("/api/hub/messaging/conversations/t1/import")
    ).toBe("crud");
  });
});

describe("hashBearerToken", () => {
  it("returns a 32-char hex prefix of sha256", () => {
    const token = "sk_test_abcdefghijklmnopqrstuvwxyz";
    const expected = createHash("sha256")
      .update(token)
      .digest("hex")
      .slice(0, 32);
    expect(hashBearerToken(token)).toBe(expected);
    expect(hashBearerToken(token)).toHaveLength(32);
  });

  it("is stable for the same input", () => {
    expect(hashBearerToken("same-token-value-xx")).toBe(
      hashBearerToken("same-token-value-xx")
    );
  });

  it("differs for different tokens", () => {
    expect(hashBearerToken("token-aaaaaaaa")).not.toBe(
      hashBearerToken("token-bbbbbbbb")
    );
  });
});

describe("buildRateLimitKey", () => {
  const ip = "203.0.113.10";

  it("keys by hashed bearer when Authorization: Bearer is present", () => {
    const token = "synap_live_abcdefghijklmnop";
    const key = buildRateLimitKey("crud", `Bearer ${token}`, ip);
    expect(key).toBe(`crud:key:${hashBearerToken(token)}`);
    // Never embeds the raw token
    expect(key).not.toContain(token);
  });

  it("falls back to IP when Authorization is missing", () => {
    expect(buildRateLimitKey("import", undefined, ip)).toBe(`import:ip:${ip}`);
  });

  it("falls back to IP for non-Bearer schemes", () => {
    expect(buildRateLimitKey("crud", "Basic abcdefghijklmnop", ip)).toBe(
      `crud:ip:${ip}`
    );
  });

  it("falls back to IP for short/garbage Bearer values", () => {
    expect(buildRateLimitKey("crud", "Bearer x", ip)).toBe(`crud:ip:${ip}`);
    expect(buildRateLimitKey("crud", "Bearer ", ip)).toBe(`crud:ip:${ip}`);
  });

  it("isolates classes under the same identity", () => {
    const auth = "Bearer synap_live_same_key_material_xx";
    const a = buildRateLimitKey("crud", auth, ip);
    const b = buildRateLimitKey("import", auth, ip);
    expect(a).not.toBe(b);
    expect(a.startsWith("crud:key:")).toBe(true);
    expect(b.startsWith("import:key:")).toBe(true);
  });
});

describe("getRateLimitClassConfig defaults", () => {
  it("exposes the locked default budgets", () => {
    const cfg = getRateLimitClassConfig();
    expect(cfg.crud.max).toBe(
      process.env.RATE_LIMIT_CRUD_MAX
        ? Number.parseInt(process.env.RATE_LIMIT_CRUD_MAX, 10)
        : 500
    );
    expect(cfg.import.max).toBe(
      process.env.RATE_LIMIT_IMPORT_MAX
        ? Number.parseInt(process.env.RATE_LIMIT_IMPORT_MAX, 10)
        : 200
    );
    expect(cfg.ai_interactive.max).toBe(
      process.env.RATE_LIMIT_AI_MAX
        ? Number.parseInt(process.env.RATE_LIMIT_AI_MAX, 10)
        : 60
    );
    expect(cfg.ai_agent_turn.max).toBe(
      process.env.RATE_LIMIT_AGENT_TURN_MAX
        ? Number.parseInt(process.env.RATE_LIMIT_AGENT_TURN_MAX, 10)
        : 120
    );
    if (!process.env.RATE_LIMIT_CRUD_WINDOW_MS) {
      expect(cfg.crud.windowMs).toBe(15 * 60 * 1000);
    }
    if (!process.env.RATE_LIMIT_AI_WINDOW_MS) {
      expect(cfg.ai_interactive.windowMs).toBe(5 * 60 * 1000);
    }
  });
});
