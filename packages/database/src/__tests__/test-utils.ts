/**
 * Test Utilities
 *
 * Helper functions for database testing.
 */

import { sql } from "../client-pg.js";
import crypto from "crypto";

/**
 * Clean test data for a specific user pattern
 */
export async function cleanTestData(userIdPattern = "test-%") {
  await sql`DELETE FROM events_timescale WHERE user_id LIKE ${userIdPattern}`;
  await sql`DELETE FROM entities WHERE user_id LIKE ${userIdPattern}`;
  await sql`DELETE FROM entity_vectors WHERE user_id LIKE ${userIdPattern}`;
  await sql`DELETE FROM knowledge_facts WHERE user_id LIKE ${userIdPattern}`;
}

/**
 * Create a test event with sensible defaults
 */
export function createTestEvent(overrides: Partial<any> = {}) {
  return {
    id: crypto.randomUUID(),
    type: "test.event",
    userId: "test-user",
    data: {},
    timestamp: new Date(),
    source: "test",
    ...overrides,
  };
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  maxWaitMs = 10000,
  checkIntervalMs = 500
): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    if (await condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
  }

  return false;
}

/**
 * Generate a unique test user ID
 */
export function generateTestUserId(prefix = "test"): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
