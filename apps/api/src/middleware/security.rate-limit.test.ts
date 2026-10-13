import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildCrudIpCeilingKey,
  buildRateLimitKey,
  classifyRateLimitPath,
  getRateLimitClassConfig,
  hashBearerToken,
  isDirectLoopbackCall,
  KRATOS_SESSION_MIN_LENGTH,
  kratosSessionFromCookieHeader,
  sharedClientIp,
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

    // calendar ICS polls (not crud, not /calendar without /feed/)
    {
      path: "/api/hub/calendar/feed/abc123.ics",
      expected: "calendar_feed",
    },
    {
      path: "/api/hub-protocol/calendar/feed/tok.ics",
      expected: "calendar_feed",
    },

    // crud (default)
    { path: "/api/hub/entities", expected: "crud" },
    { path: "/api/hub/calendar/feed", expected: "crud" },
    { path: "/api/hub/calendar/feed/rotate", expected: "crud" },
    { path: "/api/hub/knowledge/ask", expected: "crud" },
    { path: "/trpc/entities.list", expected: "crud" },
    { path: "/api/federation/bootstrap", expected: "crud" },
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

  it("does not treat /calendar (no /feed/) as calendar_feed", () => {
    expect(classifyRateLimitPath("/api/hub/calendar")).toBe("crud");
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

  it("keys calendar_feed by hashed path token, not IP", () => {
    const path = "/api/hub/calendar/feed/secret-token-value.ics";
    const key = buildRateLimitKey("calendar_feed", undefined, ip, path);
    expect(key.startsWith("calendar_feed:token:")).toBe(true);
    expect(key).not.toContain("secret-token-value");
    expect(key).not.toContain(ip);
  });

  describe("Kratos session cookie", () => {
    // Real Kratos cookies are a few hundred characters of securecookie.
    const session =
      "MTc2MDM0NTY3OHxkZXZpY2Utc2Vzc2lvbi1ibG9i_Dv-BBAEC_4IAARABEAAAR_-CAAEGc3RyaW5n";
    const cookie = `csrf_token_abc=xyz; ory_kratos_session=${session}; theme=dark`;

    it("keys by the hashed session when no Bearer is present", () => {
      const key = buildRateLimitKey("crud", undefined, ip, "/trpc/x", cookie);
      expect(key).toBe(`crud:session:${hashBearerToken(session)}`);
      expect(key).not.toContain(session);
      expect(key).not.toContain(ip);
    });

    it("gives two people behind one address two budgets", () => {
      const other = `ory_kratos_session=${"another-session-value-".padEnd(80, "x")}`;
      expect(
        buildRateLimitKey("crud", undefined, "unknown", "/", cookie)
      ).not.toBe(buildRateLimitKey("crud", undefined, "unknown", "/", other));
    });

    it("keys by IP when the session cookie is absent", () => {
      expect(
        buildRateLimitKey("crud", undefined, ip, "/", "theme=dark; csrf=1")
      ).toBe(`crud:ip:${ip}`);
      expect(buildRateLimitKey("crud", undefined, ip, "/", undefined)).toBe(
        `crud:ip:${ip}`
      );
    });

    it("lets a real Bearer win over the cookie", () => {
      const token = "synap_live_abcdefghijklmnop";
      expect(
        buildRateLimitKey("crud", `Bearer ${token}`, ip, "/", cookie)
      ).toBe(`crud:key:${hashBearerToken(token)}`);
    });

    it("falls to the cookie when the Bearer is too short to be a key", () => {
      expect(buildRateLimitKey("crud", "Bearer x", ip, "/", cookie)).toBe(
        `crud:session:${hashBearerToken(session)}`
      );
    });

    it("falls back to IP on a malformed or trivial cookie header", () => {
      for (const bad of [
        "ory_kratos_session",
        "ory_kratos_session=",
        "ory_kratos_session=  ; x=1",
        ";;=;",
        "ory_kratos_session=short",
        // Long enough for the old 20-char floor, still invented-length.
        "ory_kratos_session=MTc2MDM0NTY3OHxkZXZpY2Utc2Vzc2lvbi1ibG9i",
        `ory_kratos_session=${"a".repeat(KRATOS_SESSION_MIN_LENGTH - 1)}`,
        "not_ory_kratos_session=MTc2MDM0NTY3OHxkZXZpY2U",
      ]) {
        expect(buildRateLimitKey("crud", undefined, ip, "/", bad)).toBe(
          `crud:ip:${ip}`
        );
      }
    });

    it("keeps the calendar feed on its path token", () => {
      const path = "/api/hub/calendar/feed/secret-token-value.ics";
      expect(
        buildRateLimitKey("calendar_feed", undefined, ip, path, cookie)
      ).toMatch(/^calendar_feed:token:/);
    });
  });
});

describe("kratosSessionFromCookieHeader", () => {
  it("reads the first ory_kratos_session value, trimmed", () => {
    expect(
      kratosSessionFromCookieHeader(
        " a=1 ;ory_kratos_session= v1 ; ory_kratos_session=v2"
      )
    ).toBe("v1");
  });

  it("answers null for missing or empty values", () => {
    expect(kratosSessionFromCookieHeader(undefined)).toBeNull();
    expect(kratosSessionFromCookieHeader("")).toBeNull();
    expect(kratosSessionFromCookieHeader("ory_kratos_session=")).toBeNull();
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

describe("the address-wide crud ceiling", () => {
  it("defaults to five signed-in people's budget", () => {
    const cfg = getRateLimitClassConfig();
    if (
      !process.env.RATE_LIMIT_CRUD_IP_CEILING &&
      !process.env.RATE_LIMIT_CRUD_SESSION_MAX
    ) {
      expect(cfg.crud.sessionMax).toBe(3000);
      expect(cfg.crud.ipCeiling).toBe(15000);
    }
  });

  it("keys every request from a client address into one bucket", () => {
    expect(buildCrudIpCeilingKey("203.0.113.9", {})).toBe(
      "crud:ipall:203.0.113.9"
    );
  });

  it("has no ceiling when the address cannot tell callers apart", () => {
    expect(buildCrudIpCeilingKey("unknown", {})).toBeNull();
    expect(
      buildCrudIpCeilingKey("203.0.113.9", { SYNAP_SHARED_CLIENT_IP: "true" })
    ).toBeNull();
  });

  it("reads the shared-address signal with the public doors' spellings", () => {
    for (const on of ["1", "true", "YES", " on "]) {
      expect(sharedClientIp({ SYNAP_SHARED_CLIENT_IP: on })).toBe(true);
    }
    for (const off of [undefined, "", "false", "0", "no"]) {
      expect(sharedClientIp({ SYNAP_SHARED_CLIENT_IP: off })).toBe(false);
    }
  });
});

describe("isDirectLoopbackCall", () => {
  const ctx = (
    peer: string | undefined,
    headers: Record<string, string> = {}
  ) => ({
    env:
      peer === undefined
        ? undefined
        : { incoming: { socket: { remoteAddress: peer } } },
    req: { header: (name: string) => headers[name.toLowerCase()] },
  });

  it("is local for a loopback socket peer with no forwarding header", () => {
    for (const peer of ["127.0.0.1", "127.0.0.53", "::1", "::ffff:127.0.0.1"]) {
      expect(isDirectLoopbackCall(ctx(peer))).toBe(true);
    }
  });

  it("is never local on a header alone", () => {
    expect(
      isDirectLoopbackCall(
        ctx(undefined, { "x-forwarded-for": "127.0.0.1", "x-real-ip": "::1" })
      )
    ).toBe(false);
    expect(
      isDirectLoopbackCall(
        ctx("172.18.0.5", { "x-forwarded-for": "127.0.0.1" })
      )
    ).toBe(false);
  });

  it("is not local when a proxy on loopback relayed a client", () => {
    expect(
      isDirectLoopbackCall(
        ctx("127.0.0.1", { "x-forwarded-for": "198.51.100.7" })
      )
    ).toBe(false);
    expect(
      isDirectLoopbackCall(ctx("127.0.0.1", { "x-real-ip": "198.51.100.7" }))
    ).toBe(false);
  });

  it("is not local for a compose-network peer", () => {
    expect(isDirectLoopbackCall(ctx("172.18.0.5"))).toBe(false);
    expect(isDirectLoopbackCall(ctx("::ffff:172.18.0.5"))).toBe(false);
  });
});
