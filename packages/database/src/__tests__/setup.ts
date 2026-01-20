/**
 * Test Setup File
 *
 * Runs before all tests to set up the testing environment.
 */

import { beforeAll, afterAll } from "vitest";
import { sql } from "../client-pg.js";

// Clean up test data before all tests
beforeAll(async () => {
  console.log("🧪 Setting up test environment...");

  // Clean any existing test data
  await sql`DELETE FROM events_timescale WHERE user_id LIKE 'test-%'`;
  await sql`DELETE FROM entities WHERE user_id LIKE 'test-%'`;
  await sql`DELETE FROM entity_vectors WHERE user_id LIKE 'test-%'`;

  console.log("✅ Test environment ready");
});

// Cleanup after all tests
afterAll(async () => {
  console.log("🧹 Cleaning up test data...");

  await sql`DELETE FROM events_timescale WHERE user_id LIKE 'test-%'`;
  await sql`DELETE FROM entities WHERE user_id LIKE 'test-%'`;
  await sql`DELETE FROM entity_vectors WHERE user_id LIKE 'test-%'`;

  console.log("✅ Cleanup complete");

  // Close database connection
  await sql.end();
});
