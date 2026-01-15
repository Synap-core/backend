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
import { createTestClient, createMultiUserClients } from "./utils/test-client.js";
import type { AppRouter } from "@synap/api";

const execAsync = promisify(exec);
const logger = createLogger({ module: "e2e-setup" });

export interface TestUser {
  id: string;
  email: string;
  password: string;
  sessionCookie?: string;
  apiKey?: string;
  trpc: ReturnType<typeof createTestClient>;
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
  // Use 127.0.0.1 to avoid IPv6 resolution issues
  const apiUrl = `http://127.0.0.1:${testPort}`;

  // Wait for server to be ready (with retries)
  const maxRetries = 30; // 30 seconds total
  const retryDelay = 1000; // 1 second between retries

  // Use net.connect to verify port is listening (simplest check)
  const net = await import("net");
  
  logger.info({ apiUrl, maxRetries }, "Starting to poll API server port...");

  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`DEBUG: [Attempt ${i + 1}] Connecting to ${testPort}...`);
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(Number(testPort), "127.0.0.1");
        socket.setTimeout(2000);
        
        socket.on("connect", () => {
          socket.end();
          resolve();
        });
        
        socket.on("timeout", () => {
          socket.destroy();
          reject(new Error("Connection timed out"));
        });
        
        socket.on("error", (err) => {
          socket.destroy();
          reject(err);
        });
      });
      
      console.log(`DEBUG: [Attempt ${i + 1}] ✅ API server port is open`);
      return apiUrl;
    } catch (error) {
      console.warn(`DEBUG: [Attempt ${i + 1}] Connection failed: ${error}`);
      if (i === maxRetries - 1) {
        console.error("API server failed to start after max retries");
        throw new Error(`API server not responding after ${maxRetries} attempts`);
      }
    }
      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }

  logger.info({ apiUrl }, "Using API server URL (assuming it will be started)");
  return apiUrl;
}

/**
 * Initialize test database
 */
console.log("DEBUG: setup.ts loaded");

async function initializeTestDatabase(): Promise<void> {
  console.log("DEBUG: Initializing test database...");

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
    // SKIPPED: Migrations are now handled automatically by the Docker 'migrator' service.
    // Running them here causes race conditions and database locks leading to timeouts.
    /*
    try {
      await execAsync("cd packages/database && pnpm db:migrate", {
        env: { ...process.env, DATABASE_URL: testDbUrl },
      });
      logger.info("Migrations applied");
    } catch (error) {
      logger.warn({ err: error }, "Migration failed, continuing anyway");
    }
    */
    logger.info("Migrations skipped (handled by Docker)");
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
  apiUrl: string,
): Promise<TestUser> {
  // Simplified: Just return a mock user
  const userId = randomUUID();
  logger.info({ userId, email }, "Test user created (mock mode)");

  const sessionCookie = `mock-session-cookie=${userId}`;
  const trpc = createTestClient({ sessionCookie, apiUrl });

  return {
    id: userId,
    email,
    password,
    apiKey: process.env.TEST_API_KEY || "test-api-key-" + userId,
    sessionCookie,
    trpc,
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
    // Add timeout to prevent indefinite hang
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

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
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`API key creation failed: ${response.statusText}`);
    }

    const result = await response.json();
    // Router returns { key: "...", keyId: "..." }
    const apiKey = result.result?.data?.key;

    if (!apiKey) {
      console.error("API Key Response:", JSON.stringify(result, null, 2));
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
  console.log("DEBUG: setupTestEnvironment called");
  if (testEnv) {
    return testEnv;
  }

  console.log("DEBUG: Setting up E2E test environment...");
  logger.info("Setting up E2E test environment..."); // Keep original logging too

  // 1. Initialize database
  await initializeTestDatabase();

  // 2. Start API server
  console.log("Step 2: Starting API server connection check...");
  const apiUrl = await startApiServer();
  console.log("Step 2: API server ready at " + apiUrl);

  // 3. Create test users
  console.log("Step 3: Creating test users...");
  const userA = await createTestUser(
    "test-user-a@synap.test",
    "test-password-123",
    apiUrl,
  );
  const userB = await createTestUser(
    "test-user-b@synap.test",
    "test-password-123",
    apiUrl,
  );
  console.log("Step 3: Test users created");

  // 4. Login users and get session cookies
  userA.sessionCookie = await loginUser(userA, apiUrl);
  userB.sessionCookie = await loginUser(userB, apiUrl);

  // 5. Create API keys for Hub Protocol testing
  console.log("Step 5: Creating API keys...");
  try {
    userA.apiKey = await createApiKey(userA.id, apiUrl, userA.sessionCookie);
    userB.apiKey = await createApiKey(userB.id, apiUrl, userB.sessionCookie);
    console.log("Step 5: API keys created");
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
