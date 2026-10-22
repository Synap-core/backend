/**
 * Test Utilities
 *
 * Helper functions for database testing.
 */

import { sql } from "../client-pg.js";
import crypto from "crypto";

/**
 * The user ids THIS test file generated (generateTestUserId). Vitest runs the
 * package's files in parallel against ONE database, and every file runs
 * setup.ts: a cleanup by pattern (`user_id LIKE 'test-%'`) deleted the rows a
 * test in ANOTHER file had just written ("expected 9 to be 10"). A file only
 * ever deletes its own users' rows. Module state is per file (vitest isolates
 * each file's modules).
 */
const generatedUserIds = new Set<string>();

/** Deletes the rows of every user id this file generated — never another file's. */
export async function cleanTestData() {
  const ids = [...generatedUserIds];
  if (ids.length === 0) return;
  await sql`DELETE FROM events WHERE user_id = ANY(${ids})`;
  await sql`DELETE FROM entities WHERE user_id = ANY(${ids})`;
  await sql`DELETE FROM entity_vectors WHERE user_id = ANY(${ids})`;
  await sql`DELETE FROM knowledge_facts WHERE user_id = ANY(${ids})`;
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
  const id = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  generatedUserIds.add(id);
  return id;
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
