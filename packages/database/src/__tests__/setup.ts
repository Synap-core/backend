/**
 * Test Setup File
 *
 * Runs before all tests to set up the testing environment.
 */

import { afterAll } from "vitest";
import { sql } from "../client-pg.js";
import { cleanTestData } from "./test-utils.js";

// Every file of the package runs this, in parallel against one database: it
// deletes only the rows of the users THIS file generated (test-utils.ts),
// never a pattern that matches another file's in-flight rows.
afterAll(async () => {
  await cleanTestData();

  // Close database connection
  await sql.end();
});
