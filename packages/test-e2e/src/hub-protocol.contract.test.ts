/**
 * Hub Protocol Contract Tests
 *
 * Validates the Hub Protocol REST API contract with real HTTP calls
 * against a running backend instance (no mocks).
 *
 * Prerequisites:
 *   - Backend running at TEST_API_PORT (default 4000)
 *   - DATABASE_URL pointing at a migrated test database
 *
 * The suite seeds its own user + workspace + API key in beforeAll and cleans
 * them up in afterAll, so it is safe to run repeatedly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, randomBytes } from "crypto";
import bcrypt from "bcrypt";
import {
  db,
  eq,
  users,
  workspaces,
  workspaceMembers,
  entities,
  apiKeys,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "hub-protocol-contract" });

// ─── Config ───────────────────────────────────────────────────────────────────

const TEST_API_PORT = process.env.TEST_API_PORT ?? "4000";
const BASE_URL = `http://127.0.0.1:${TEST_API_PORT}`;
const HUB_BASE = `${BASE_URL}/api/hub`;

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function hubRequest(
  method: string,
  path: string,
  options: {
    apiKey?: string;
    body?: unknown;
  } = {}
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.apiKey) {
    headers["Authorization"] = `Bearer ${options.apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${HUB_BASE}${path}`, {
      method,
      headers,
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    let body: unknown;
    const ct = response.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      body = await response.json();
    } else {
      body = await response.text();
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_USER_ID = `contract-${randomUUID()}`;
const TEST_USER_EMAIL = `contract-${randomUUID()}@synap.test`;

// Plaintext key stored here for use in tests; hash stored in DB
let testApiKey = "";
let testApiKeyId = "";
let testWorkspaceId = "";
const createdEntityIds: string[] = [];

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("Hub Protocol contracts", () => {
  // ── Setup ──────────────────────────────────────────────────────────────────
  beforeAll(async () => {
    logger.info({ userId: TEST_USER_ID }, "Seeding contract-test fixtures");

    // 1. Insert test user
    await db.insert(users).values({
      id: TEST_USER_ID,
      email: TEST_USER_EMAIL,
      name: "Contract Test User",
      userType: "human",
      emailVerified: true,
    });

    // 2. Create workspace
    const [ws] = await db
      .insert(workspaces)
      .values({
        ownerId: TEST_USER_ID,
        name: "Contract Test Workspace",
        type: "personal",
      })
      .returning({ id: workspaces.id });

    testWorkspaceId = ws.id;

    // 3. Add owner membership
    await db.insert(workspaceMembers).values({
      workspaceId: testWorkspaceId,
      userId: TEST_USER_ID,
      role: "owner",
    });

    // 4. Generate + hash API key (mirrors ApiKeyRepository.create logic)
    const rawKey = `synap_hub_test_${randomBytes(32).toString("hex")}`;
    const keyHash = await bcrypt.hash(rawKey, 12);
    const [keyRecord] = await db
      .insert(apiKeys)
      .values({
        userId: TEST_USER_ID,
        keyName: "contract-test-key",
        keyPrefix: "synap_hub_test_",
        keyHash,
        keyType: "hub_inbound",
        scope: ["hub-protocol.read", "hub-protocol.write"],
        isActive: true,
        usageCount: 0,
      })
      .returning({ id: apiKeys.id });

    testApiKey = rawKey;
    testApiKeyId = keyRecord.id;

    logger.info(
      { workspaceId: testWorkspaceId, keyId: testApiKeyId },
      "Fixtures ready"
    );
  }, 60_000);

  afterAll(async () => {
    logger.info("Cleaning up contract-test fixtures");

    // Remove any entities we created during the test run
    for (const id of createdEntityIds) {
      await db
        .delete(entities)
        .where(eq(entities.id, id))
        .catch(() => {});
    }

    // Revoke & remove API key
    if (testApiKeyId) {
      await db
        .update(apiKeys)
        .set({
          isActive: false,
          revokedAt: new Date(),
          revokedReason: "contract-test cleanup",
        })
        .where(eq(apiKeys.id, testApiKeyId))
        .catch(() => {});
      await db
        .delete(apiKeys)
        .where(eq(apiKeys.id, testApiKeyId))
        .catch(() => {});
    }

    // Remove workspace membership, workspace, user
    await db
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, testWorkspaceId))
      .catch(() => {});
    await db
      .delete(workspaces)
      .where(eq(workspaces.id, testWorkspaceId))
      .catch(() => {});
    await db
      .delete(users)
      .where(eq(users.id, TEST_USER_ID))
      .catch(() => {});

    logger.info("Contract-test cleanup complete");
  });

  // ── Auth operations ────────────────────────────────────────────────────────
  describe("Auth operations", () => {
    it("GET /entities/:id without Authorization header → 401", async () => {
      const { status } = await hubRequest("GET", "/entities/nonexistent-id");
      expect(status).toBe(401);
    });

    it("GET /entities/:id with invalid API key → 401", async () => {
      const { status } = await hubRequest("GET", "/entities/nonexistent-id", {
        apiKey:
          "synap_user_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      });
      expect(status).toBe(401);
    });

    it("GET /users/me → 200, returns { id, scopes }", async () => {
      const { status, body } = await hubRequest("GET", "/users/me", {
        apiKey: testApiKey,
      });
      expect(status).toBe(200);
      const user = body as Record<string, unknown>;
      expect(user).toHaveProperty("id", TEST_USER_ID);
      expect(user).toHaveProperty("scopes");
      expect(Array.isArray(user.scopes)).toBe(true);
    });
  });

  // ── Entity operations ──────────────────────────────────────────────────────
  describe("Entity operations", () => {
    it("POST /entities { profileSlug: 'note', title: '...' } → 200, returns { id, title }", async () => {
      const { status, body } = await hubRequest("POST", "/entities", {
        apiKey: testApiKey,
        body: {
          userId: TEST_USER_ID,
          profileSlug: "note",
          title: "contract-test-note",
          workspaceId: testWorkspaceId,
        },
      });
      expect(status).toBe(200);
      const entity = body as Record<string, unknown>;
      expect(entity).toHaveProperty("id");
      expect(entity).toHaveProperty("title", "contract-test-note");
      // profileSlug may come back as a separate field or embedded in profile
      if (typeof entity.id === "string") {
        createdEntityIds.push(entity.id);
      }
    });

    it("GET /entities/:id → 200, returns the same entity", async () => {
      expect(createdEntityIds.length).toBeGreaterThan(0);
      const entityId = createdEntityIds[0];

      const { status, body } = await hubRequest(
        "GET",
        `/entities/${entityId}`,
        {
          apiKey: testApiKey,
        }
      );
      expect(status).toBe(200);
      const entity = body as Record<string, unknown>;
      expect(entity).toHaveProperty("id", entityId);
    });

    it("GET /search?q=contract-test-note → 200 or 503 (Typesense may be absent in CI)", async () => {
      const path = `/search?query=contract-test-note&userId=${TEST_USER_ID}&workspaceId=${testWorkspaceId}`;
      const { status } = await hubRequest("GET", path, { apiKey: testApiKey });
      // Typesense is optional in CI — treat both as acceptable
      expect([200, 400, 503]).toContain(status);
    });

    it("POST /entities with missing title (invalid body) → ≥ 400", async () => {
      const { status } = await hubRequest("POST", "/entities", {
        apiKey: testApiKey,
        body: {
          userId: TEST_USER_ID,
          profileSlug: "note",
          // title intentionally omitted
        },
      });
      expect(status).toBeGreaterThanOrEqual(400);
    });
  });

  // ── Document operations ────────────────────────────────────────────────────
  describe("Document operations", () => {
    it("POST /documents { title, content } → 200, returns { id, title }", async () => {
      const { status, body } = await hubRequest("POST", "/documents", {
        apiKey: testApiKey,
        body: {
          userId: TEST_USER_ID,
          workspaceId: testWorkspaceId,
          title: "contract-test-doc",
          content: "hello",
          type: "markdown",
        },
      });
      expect(status).toBe(200);
      const doc = body as Record<string, unknown>;
      expect(doc).toHaveProperty("id");
      expect(doc).toHaveProperty("title", "contract-test-doc");
    });
  });

  // ── Memory operations ──────────────────────────────────────────────────────
  describe("Memory operations", () => {
    it("POST /memory { fact, context } → 200", async () => {
      const { status } = await hubRequest("POST", "/memory", {
        apiKey: testApiKey,
        body: {
          userId: TEST_USER_ID,
          fact: "contract test fact for smoke",
          context: "testing",
          // embedding is optional — zero-vector fallback used when absent
        },
      });
      expect(status).toBe(200);
    });
  });

  // ── Channel / thread operations ────────────────────────────────────────────
  describe("Channel operations", () => {
    it("GET /threads?userId=... → 200, returns array", async () => {
      const { status, body } = await hubRequest(
        "GET",
        `/threads?userId=${TEST_USER_ID}`,
        { apiKey: testApiKey }
      );
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
    });
  });
});
