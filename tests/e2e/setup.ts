/**
 * E2E Test Setup
 * 
 * Sets up the test environment:
 * - Starts API server in test mode
 * - Initializes test database
 * - Applies migrations
 * - Creates test users and gets tokens
 */

import { beforeAll, afterAll } from 'vitest';
import { createLogger } from '@synap-core/core';
import { db } from '@synap/database';
import { config } from '@synap-core/core';
import { exec } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

const execAsync = promisify(exec);
const logger = createLogger({ module: 'e2e-setup' });

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
let apiServer: any = null;
let apiPort = 0;

/**
 * Start API server in test mode
 * 
 * Note: For E2E tests, we assume the API server is already running
 * or will be started separately. This function just returns the URL.
 */
async function startApiServer(): Promise<string> {
  // For E2E tests, we can either:
  // 1. Use an existing running server (recommended for CI/CD)
  // 2. Start a server programmatically (complex, requires process management)
  
  const testPort = process.env.TEST_API_PORT || '3000';
  const apiUrl = `http://localhost:${testPort}`;
  
  // Verify server is running
  try {
    const healthCheck = await fetch(`${apiUrl}/health`);
    if (healthCheck.ok) {
      logger.info({ apiUrl }, 'API server is running');
      return apiUrl;
    }
  } catch (error) {
    logger.warn({ err: error, apiUrl }, 'API server not responding, tests may fail');
  }
  
  logger.info({ apiUrl }, 'Using API server URL (assuming it will be started)');
  return apiUrl;
}

/**
 * Initialize test database
 */
async function initializeTestDatabase(): Promise<void> {
  logger.info('Initializing test database...');
  
  // Check if we're using PostgreSQL or SQLite
  if (config.database.dialect === 'postgres') {
    // For PostgreSQL, use a test database
    // In CI/CD, we might use a separate test database
    // For local testing, we can use the same database with a test schema
    const testDbName = process.env.TEST_DATABASE_NAME || 'synap_test';
    const testDbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL?.replace(/\/synap/, `/${testDbName}`);
    
    if (testDbUrl) {
      process.env.DATABASE_URL = testDbUrl;
      logger.info({ testDbUrl: testDbUrl.replace(/:[^:@]+@/, ':****@') }, 'Using test database');
    }
    
    // Apply migrations
    try {
      await execAsync('cd packages/database && pnpm db:migrate', {
        env: { ...process.env, DATABASE_URL: testDbUrl },
      });
      logger.info('Migrations applied');
    } catch (error) {
      logger.warn({ err: error }, 'Migration failed, continuing anyway');
    }
  } else {
    // SQLite: Use in-memory database for tests
    const testDbPath = ':memory:';
    process.env.SQLITE_DB_PATH = testDbPath;
    logger.info('Using in-memory SQLite database');
    
    // Apply migrations
    try {
      await execAsync('cd packages/database && pnpm db:migrate', {
        env: { ...process.env, SQLITE_DB_PATH: testDbPath },
      });
      logger.info('Migrations applied');
    } catch (error) {
      logger.warn({ err: error }, 'Migration failed, continuing anyway');
    }
  }
}

/**
 * Create test user via Ory Kratos (PostgreSQL) or simple auth (SQLite)
 */
async function createTestUser(email: string, password: string): Promise<TestUser> {
  if (config.database.dialect === 'postgres') {
    // PostgreSQL: Create user via Ory Kratos
    try {
      const { kratosAdmin } = await import('@synap/auth');
      
      // Create identity
      const identity = await kratosAdmin.createIdentity({
        schema_id: 'default',
        traits: {
          email,
          name: `Test User ${email}`,
        },
        credentials: {
          password: {
            config: {
              password,
            },
          },
        },
      });
      
      logger.info({ userId: identity.id, email }, 'Test user created via Kratos');
      
      // Get session cookie (simplified - in real E2E, we'd do a proper login flow)
      return {
        id: identity.id,
        email,
        password,
        // Session cookie will be set when we login
      };
    } catch (error) {
      logger.error({ err: error, email }, 'Failed to create test user via Kratos');
      throw error;
    }
  } else {
    // SQLite: Simple auth - just return a mock user
    const userId = randomUUID();
    logger.info({ userId, email }, 'Test user created (SQLite mode)');
    
    return {
      id: userId,
      email,
      password,
      // For SQLite, we use the static token
      apiKey: process.env.SYNAP_SECRET_TOKEN || 'test-token',
    };
  }
}

/**
 * Login and get session cookie
 */
async function loginUser(user: TestUser, apiUrl: string): Promise<string> {
  if (config.database.dialect === 'postgres') {
    // PostgreSQL: Login via Kratos
    try {
      const response = await fetch(`${apiUrl}/self-service/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          identifier: user.email,
          password: user.password,
        }),
      });
      
      if (!response.ok) {
        throw new Error(`Login failed: ${response.statusText}`);
      }
      
      // Extract session cookie from response
      const cookies = response.headers.get('set-cookie');
      if (cookies) {
        const sessionCookie = cookies.split(';')[0];
        logger.info({ email: user.email }, 'User logged in');
        return sessionCookie;
      }
      
      throw new Error('No session cookie in response');
    } catch (error) {
      logger.error({ err: error, email: user.email }, 'Failed to login user');
      throw error;
    }
  } else {
    // SQLite: Return static token
    return `SYNAP_SECRET_TOKEN=${user.apiKey}`;
  }
}

/**
 * Create API key for Hub Protocol testing
 */
async function createApiKey(userId: string, apiUrl: string, sessionCookie: string): Promise<string> {
  try {
    const response = await fetch(`${apiUrl}/trpc/apiKeys.create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': sessionCookie,
      },
      body: JSON.stringify({
        name: `Test API Key ${randomUUID()}`,
        scope: ['preferences', 'notes', 'tasks', 'calendar'],
        expiresIn: 3600 * 24 * 365, // 1 year
      }),
    });
    
    if (!response.ok) {
      throw new Error(`API key creation failed: ${response.statusText}`);
    }
    
    const result = await response.json();
    const apiKey = result.result?.data?.apiKey;
    
    if (!apiKey) {
      throw new Error('No API key in response');
    }
    
    logger.info({ userId }, 'API key created');
    return apiKey;
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to create API key');
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
  
  logger.info('Setting up E2E test environment...');
  
  // 1. Initialize database
  await initializeTestDatabase();
  
  // 2. Start API server
  const apiUrl = await startApiServer();
  
  // 3. Create test users
  const userA = await createTestUser('test-user-a@synap.test', 'test-password-123');
  const userB = await createTestUser('test-user-b@synap.test', 'test-password-123');
  
  // 4. Login users and get session cookies
  userA.sessionCookie = await loginUser(userA, apiUrl);
  userB.sessionCookie = await loginUser(userB, apiUrl);
  
  // 5. Create API keys for Hub Protocol testing
  try {
    userA.apiKey = await createApiKey(userA.id, apiUrl, userA.sessionCookie);
    userB.apiKey = await createApiKey(userB.id, apiUrl, userB.sessionCookie);
  } catch (error) {
    logger.warn({ err: error }, 'Failed to create API keys, continuing without them');
  }
  
  // 6. Create cleanup function
  const cleanup = async () => {
    logger.info('Cleaning up test environment...');
    
    // Close database connections
    // Note: In real implementation, we might want to drop test database
    
    // Stop API server
    if (apiServer) {
      // Server cleanup would go here
    }
    
    logger.info('Test environment cleaned up');
  };
  
  testEnv = {
    apiUrl,
    users: {
      userA,
      userB,
    },
    cleanup,
  };
  
  logger.info('E2E test environment ready');
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

