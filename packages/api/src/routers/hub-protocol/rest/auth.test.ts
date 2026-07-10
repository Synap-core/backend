/**
 * Hub Protocol REST — auth surface tests.
 *
 * Covers:
 * 1. `/auth/status` returns the expected shape with a valid bearer.
 * 2. `/auth/status` returns 401 with the standardized envelope when no
 *    bearer is supplied.
 * 3. `/auth/status` returns 401 with `reason: key_revoked` when the bearer
 *    matches no active key in the DB.
 * 4. `/openapi.json` is publicly reachable (no auth required) and emits a
 *    valid OpenAPI 3.1 doc.
 * 5. The OpenAPI doc declares the `bearerAuth` security scheme + the
 *    `AuthErrorEnvelope` schema.
 *
 * Strategy: build an ISOLATED Hono app per test that mounts only the auth
 * middleware + auth route — keeps the surface tight and avoids pulling in
 * the full hub-protocol-rest orchestrator (which would require 30+ DB
 * mocks). The middleware logic under test mirrors the orchestrator
 * verbatim — keep these in sync with `hub-protocol-rest.ts` if the auth
 * decision tree changes there.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@synap/database", () => {
  // Tiny chainable stub — we only need .select(...).from(...).leftJoin(...).where(...)
  // to resolve to an array. The auth middleware itself uses `apiKeyService`,
  // which we mock separately.
  const makeQueryBuilder = (resolvedRows: unknown[] = []) => {
    const builder: Record<string, () => unknown> = {};
    builder.from = () => builder;
    builder.leftJoin = () => builder;
    builder.where = () => Promise.resolve(resolvedRows);
    return builder;
  };

  // Per-test rows are set via a module-level `_setRows` helper so each test
  // can prime the join result independently.
  let nextRows: unknown[] = [];
  const select = vi.fn(() => makeQueryBuilder(nextRows));

  return {
    db: {
      select,
      _setRows: (rows: unknown[]) => {
        nextRows = rows;
      },
    },
    apiKeys: { id: "id" },
    users: { id: "id" },
    eq: vi.fn((a, b) => ({ type: "eq", a, b })),
    ChannelType: {
      THREAD: "thread",
      PERSONAL: "personal",
      SUB_THREAD: "sub_thread",
      FEED: "feed",
      EXTERNAL: "external",
      AGENT_COLLAB: "agent_collab",
      GROUP: "group",
    },
  };
});

vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: {
    getApiKeyStatus: vi.fn(),
    recordKeyUse: vi.fn(),
    checkRateLimit: vi.fn(() => true),
  },
}));

vi.mock("../../../services/external-user-mapping.js", () => ({
  isSubTokenFeatureEnabled: vi.fn(() => false),
  resolveExternalUserMapping: vi.fn(() => Promise.resolve(null)),
}));

// Imports must come AFTER vi.mock (ESM hoisting handles this, but tools
// disagree — keep imports here for clarity).
import { OpenAPIHono } from "@hono/zod-openapi";
import { registerAuthRoutes } from "./auth.js";
import { authErrorResponse, shortenKeyId } from "../../../utils/auth-error.js";
import { AuthErrorEnvelopeSchema } from "./_codecs/auth.js";
import { apiKeyService } from "../../../services/api-keys.js";
import { db } from "@synap/database";
import type { HubHono, HubVariables } from "./_shared.js";

// ─── Test app builder ───────────────────────────────────────────────────────

/**
 * Reproduce just the bits of hub-protocol-rest.ts we want under test:
 * 1. Auth middleware that uses apiKeyService.getApiKeyStatus + the structured
 *    envelope helper.
 * 2. The /auth/status route mounted via `registerAuthRoutes`.
 *
 * The skipAuthPaths list mirrors the orchestrator so the discovery test
 * covers the same surface.
 */
function buildTestApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();

  // Same security scheme + 401 component as the orchestrator
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
  });
  app.openAPIRegistry.register("AuthErrorEnvelope", AuthErrorEnvelopeSchema);
  app.openAPIRegistry.registerComponent("responses", "Unauthorized", {
    description: "Auth failed.",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/AuthErrorEnvelope" },
      },
    },
  });

  app.use("/*", async (c, next) => {
    const reqPath = c.req.path;
    const skipAuthPaths = ["/health", "/openapi.json", "/docs"];
    if (skipAuthPaths.some((p) => reqPath === p || reqPath.endsWith(p))) {
      return next();
    }

    const authHeader = c.req.header("authorization") ?? null;
    const match = authHeader?.match(/^Bearer\s+(.+)$/i);
    const token = match ? match[1].trim() : null;

    if (!token) {
      return authErrorResponse(c, "no_auth");
    }

    const status = await apiKeyService.getApiKeyStatus(token);
    if (status.status === "invalid_format") {
      return authErrorResponse(c, "invalid_format");
    }
    if (status.status === "not_found") {
      return authErrorResponse(c, "key_revoked");
    }
    if (status.status === "revoked") {
      return authErrorResponse(c, "key_revoked", {
        keyIdPrefix: shortenKeyId(status.record.id),
      });
    }
    if (status.status === "expired") {
      return authErrorResponse(c, "expired", {
        keyIdPrefix: shortenKeyId(status.record.id),
      });
    }

    c.set("userId", status.record.userId);
    c.set("scopes", (status.record.scope ?? []) as string[]);
    c.set("apiKeyId", status.record.id);
    return next();
  });

  registerAuthRoutes(app);

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Test", version: "1.0.0" },
    security: [{ bearerAuth: [] }],
  });

  return app;
}

// ─── Test fixtures ──────────────────────────────────────────────────────────

const VALID_KEY = "synap_user_test-token-abc";
const KEY_ROW = {
  id: "01234567-89ab-cdef-0123-456789abcdef",
  userId: "user-1",
  keyName: "Test Key",
  scope: ["hub-protocol.read", "hub-protocol.write"],
  isActive: true,
  expiresAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  lastUsedAt: new Date("2026-04-01T00:00:00Z"),
  parentKeyId: null,
} as const;

const JOIN_ROW = {
  keyId: KEY_ROW.id,
  userId: KEY_ROW.userId,
  name: KEY_ROW.keyName,
  scope: KEY_ROW.scope,
  createdAt: KEY_ROW.createdAt,
  expiresAt: KEY_ROW.expiresAt,
  lastUsedAt: KEY_ROW.lastUsedAt,
  parentKeyId: KEY_ROW.parentKeyId,
  isActive: KEY_ROW.isActive,
  userEmail: "alice@example.com",
  userName: "Alice",
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default DB mock: empty rows. Tests override per-case.
  (db as unknown as { _setRows: (r: unknown[]) => void })._setRows([]);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("/auth/status — happy path", () => {
  it("returns the expected shape with a valid bearer", async () => {
    vi.mocked(apiKeyService.getApiKeyStatus).mockResolvedValue({
      status: "valid",
      record: KEY_ROW as never,
    });
    (db as unknown as { _setRows: (r: unknown[]) => void })._setRows([
      JOIN_ROW,
    ]);

    const app = buildTestApp();
    const res = await app.request("/auth/status", {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      keyId: KEY_ROW.id,
      keyIdPrefix: "01234567",
      userId: KEY_ROW.userId,
      userEmail: "alice@example.com",
      userName: "Alice",
      name: "Test Key",
      scopes: ["hub-protocol.read", "hub-protocol.write"],
      isActive: true,
      parentKeyId: null,
    });
    // ISO strings, not Date objects (the wire schema declares string-datetime)
    expect(typeof body.createdAt).toBe("string");
    expect(body.lastUsedAt).toContain("2026-04-01");
    expect(body.expiresAt).toBe(null);
  });
});

describe("/auth/status — 401 envelope", () => {
  it("returns reason=no_auth when no bearer is supplied", async () => {
    const app = buildTestApp();
    const res = await app.request("/auth/status");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({
      error: "unauthorized",
      reason: "no_auth",
    });
    expect(typeof body.message).toBe("string");
  });

  it("returns reason=key_revoked when bearer matches no active row", async () => {
    vi.mocked(apiKeyService.getApiKeyStatus).mockResolvedValue({
      status: "not_found",
    });
    const app = buildTestApp();
    const res = await app.request("/auth/status", {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.reason).toBe("key_revoked");
    expect(body.error).toBe("unauthorized");
  });

  it("returns reason=key_revoked + keyIdPrefix when row was deactivated", async () => {
    vi.mocked(apiKeyService.getApiKeyStatus).mockResolvedValue({
      status: "revoked",
      record: { ...KEY_ROW, isActive: false } as never,
    });
    const app = buildTestApp();
    const res = await app.request("/auth/status", {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.reason).toBe("key_revoked");
    expect(body.keyIdPrefix).toBe("01234567");
  });

  it("returns reason=expired when the row has expiresAt in the past", async () => {
    vi.mocked(apiKeyService.getApiKeyStatus).mockResolvedValue({
      status: "expired",
      record: {
        ...KEY_ROW,
        expiresAt: new Date("2020-01-01T00:00:00Z"),
      } as never,
    });
    const app = buildTestApp();
    const res = await app.request("/auth/status", {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.reason).toBe("expired");
    expect(body.keyIdPrefix).toBe("01234567");
  });

  it("returns reason=invalid_format for malformed prefix", async () => {
    vi.mocked(apiKeyService.getApiKeyStatus).mockResolvedValue({
      status: "invalid_format",
    });
    const app = buildTestApp();
    const res = await app.request("/auth/status", {
      headers: { authorization: "Bearer not-a-synap-key" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.reason).toBe("invalid_format");
  });
});

describe("/openapi.json — public discovery", () => {
  it("is reachable without auth", async () => {
    const app = buildTestApp();
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
  });

  it("returns OpenAPI 3.1 with the expected envelope schema and security scheme", async () => {
    const app = buildTestApp();
    const res = await app.request("/openapi.json");
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.openapi).toBe("3.1.0");
    const components = doc.components as Record<string, unknown>;
    expect(components).toBeDefined();

    const schemes = components.securitySchemes as Record<string, unknown>;
    expect(schemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });

    const schemas = components.schemas as Record<string, unknown>;
    expect(schemas.AuthErrorEnvelope).toBeDefined();

    // Global `security` is declared at the top level
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
  });
});
