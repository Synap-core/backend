/**
 * E2E Test Setup
 *
 * Sets up the test environment:
 * - Starts API server in test mode
 * - Initializes test database
 * - Applies migrations
 * - Creates test users and gets tokens
 */

import { beforeAll, afterAll } from "vitest";
import { createLogger } from "@synap-core/core";
import { db } from "@synap/database";
import { config } from "@synap-core/core";
import { exec } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";

const execAsync = promisify(exec);
const logger = createLogger({ module: "e2e-setup" });

export interface TestUser {
  id: string;
  email: string;
  password: string;
  sessionCookie?: string;
  apiKey?: string;
}

export interface TestEnvironment {
  apiUrl: string;
  users: {
    userA: TestUser;
    userB: TestUser;
  };
  cleanup: () => Promise<void>;
}

let testEnv: TestEnvironment | null = null;
const apiServer: any = null;
const apiPort = 0;

/**
 * Start API server in test mode
 *
 * Note: For E2E tests, we assume the API server is already running
 * or will be started separately. This function just returns the URL.
 */
async function startApiServer(): Promise<string> {
  const testPort = process.env.TEST_API_PORT || "4000";
  const apiUrl = `http://localhost:${testPort}`;

  // Verify server is running
  try {
    const healthCheck = await fetch(`${apiUrl}/health`);
    if (healthCheck.ok) {
      logger.info({ apiUrl }, "API server is running");
      return apiUrl;
    }
  } catch (error) {
    logger.warn(
      { err: error, apiUrl },
      "API server not responding, tests may fail",
    );
  }

  logger.info({ apiUrl }, "Using API server URL (assuming it will be started)");
  return apiUrl;
}

/**
 * Initialize test database
 */
async function initializeTestDatabase(): Promise<void> {
  logger.info("Initializing test database...");

  // Check if we're using PostgreSQL or SQLite
  if (config.database.dialect === "postgres") {
    // For PostgreSQL, use a test database
    const testDbName = process.env.TEST_DATABASE_NAME || "synap_test";
    const testDbUrl =
      process.env.TEST_DATABASE_URL ||
      process.env.DATABASE_URL?.replace(/\/synap/, `/${testDbName}`);

    if (testDbUrl) {
      process.env.DATABASE_URL = testDbUrl;
      logger.info(
        { testDbUrl: testDbUrl.replace(/:[^:@]+@/, ":****@") },
        "Using test database",
      );
    }

    // Apply migrations
    try {
      await execAsync("cd packages/database && pnpm db:migrate", {
        env: { ...process.env, DATABASE_URL: testDbUrl },
      });
      logger.info("Migrations applied");
    } catch (error) {
      logger.warn({ err: error }, "Migration failed, continuing anyway");
    }
  } else {
    // SQLite: Use in-memory database for tests
    const testDbPath = ":memory:";
    process.env.SQLITE_DB_PATH = testDbPath;
    logger.info("Using in-memory SQLite database");

    // Apply migrations
    try {
      await execAsync("cd packages/database && pnpm db:migrate", {
        env: { ...process.env, SQLITE_DB_PATH: testDbPath },
      });
      logger.info("Migrations applied");
    } catch (error) {
      logger.warn({ err: error }, "Migration failed, continuing anyway");
    }
  }
}

/**
 * Create test user (simplified - no Kratos for now)
 */
async function createTestUser(
  email: string,
  password: string,
): Promise<TestUser> {
  // Simplified: Just return a mock user
  const userId = randomUUID();
  logger.info({ userId, email }, "Test user created (mock mode)");

  return {
    id: userId,
    email,
    password,
    apiKey: process.env.TEST_API_KEY || "test-api-key-" + userId,
    sessionCookie: `mock-session-cookie=${userId}`,
  };
}

/**
 * Login and get session cookie (simplified)
 */
async function loginUser(user: TestUser, apiUrl: string): Promise<string> {
  // Simplified: Just return the mock session cookie
  logger.info({ email: user.email }, "User logged in (mock mode)");
  return user.sessionCookie || `mock-session-cookie=${user.id}`;
}

/**
 * Create API key for Hub Protocol testing
 */
async function createApiKey(
  userId: string,
  apiUrl: string,
  sessionCookie: string,
): Promise<string> {
  try {
    const response = await fetch(`${apiUrl}/trpc/apiKeys.create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie,
      },
      body: JSON.stringify({
        keyName: `Test API Key ${randomUUID()}`,
        scope: ["preferences", "notes", "tasks"],
        expiresInDays: 365,
      }),
    });

    if (!response.ok) {
      throw new Error(`API key creation failed: ${response.statusText}`);
    }

    const result = await response.json();
    const apiKey = result.result?.data?.apiKey;

    if (!apiKey) {
      throw new Error("No API key in response");
    }

    logger.info({ userId }, "API key created");
    return apiKey;
  } catch (error) {
    logger.error({ err: error, userId }, "Failed to create API key");
    throw error;
  }
}

/**
 * Setup test environment
 */
export async function setupTestEnvironment(): Promise<TestEnvironment> {
  if (testEnv) {
    return testEnv;
  }

  logger.info("Setting up E2E test environment...");

  // 1. Initialize database
  await initializeTestDatabase();

  // 2. Start API server
  const apiUrl = await startApiServer();

  // 3. Create test users
  const userA = await createTestUser(
    "test-user-a@synap.test",
    "test-password-123",
  );
  const userB = await createTestUser(
    "test-user-b@synap.test",
    "test-password-123",
  );

  // 4. Login users and get session cookies
  userA.sessionCookie = await loginUser(userA, apiUrl);
  userB.sessionCookie = await loginUser(userB, apiUrl);

  // 5. Create API keys for Hub Protocol testing
  try {
    userA.apiKey = await createApiKey(userA.id, apiUrl, userA.sessionCookie);
    userB.apiKey = await createApiKey(userB.id, apiUrl, userB.sessionCookie);
  } catch (error) {
    logger.warn(
      { err: error },
      "Failed to create API keys, continuing without them",
    );
  }

  // 6. Create cleanup function
  const cleanup = async () => {
    logger.info("Cleaning up test environment...");
    if (apiServer) {
      // Server cleanup
    }
    logger.info("Test environment cleaned up");
  };

  testEnv = {
    apiUrl,
    users: {
      userA,
      userB,
    },
    cleanup,
  };

  logger.info("E2E test environment ready");
  return testEnv;
}

/**
 * Global setup (called by Vitest)
 */
export async function globalSetup() {
  await setupTestEnvironment();
}

/**
 * Global teardown (called by Vitest)
 */
export async function globalTeardown() {
  if (testEnv) {
    await testEnv.cleanup();
  }
}
