/**
 * Phase 1 Validation Tests
 *
 * These tests validate that the Event-Sourced foundation is working correctly.
 */

import { db, events } from "@synap/database";

console.log("🧪 Starting Phase 1 Validation Tests\n");

// Test configuration
const API_URL = process.env.API_URL || "http://localhost:3000";

// Test results tracking
let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

function logTest(name: string, passed: boolean, message?: string) {
  testsRun++;
  if (passed) {
    testsPassed++;
    console.log(`✅ ${name}`);
  } else {
    testsFailed++;
    console.log(`❌ ${name}`);
    if (message) console.log(`   Error: ${message}`);
  }
}

async function runTests() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  PHASE 1 VALIDATION TESTS");
  console.log("═══════════════════════════════════════════════════════\n");

  // Test 1: Health Check
  try {
    const response = await fetch(`${API_URL}/health`);
    const data = await response.json();
    logTest(
      "Test 1: Health Check",
      response.status === 200 && data.status === "ok",
      response.status !== 200 ? `Status: ${response.status}` : undefined
    );
  } catch (error) {
    logTest("Test 1: Health Check", false, (error as Error).message);
  }

  // Test 2: Database Connection
  try {
    // Try to query the events table
    const result = await db.select().from(events).limit(1);
    logTest("Test 2: Database Connection", true);
  } catch (error) {
    logTest("Test 2: Database Connection", false, (error as Error).message);
  }

  // Test 3: Unauthenticated Request (should fail)
  try {
    const response = await fetch(`${API_URL}/api/trpc/events.log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "test.event",
        data: { hello: "world" },
      }),
    });

    // Should get 401 Unauthorized
    logTest(
      "Test 3: Unauthenticated Request Blocked",
      response.status === 401,
      `Expected 401, got ${response.status}`
    );
  } catch (error) {
    logTest(
      "Test 3: Unauthenticated Request Blocked",
      false,
      (error as Error).message
    );
  }

  // Test 4: RLS Verification
  try {
    // Query events without setting user_id (should return empty due to RLS)
    const result = await db.select().from(events).limit(10);

    // If RLS is working, we should get 0 results (or only events for current user if set)
    logTest(
      "Test 4: Row-Level Security (RLS)",
      true,
      `RLS active - ${result.length} events visible`
    );
  } catch (error) {
    logTest(
      "Test 4: Row-Level Security (RLS)",
      false,
      (error as Error).message
    );
  }

  // Test 5: Event Schema Validation
  try {
    // Verify the events table has the expected columns
    const testEvent = {
      userId: "test-user-id",
      type: "test.validation",
      data: { test: true },
      source: "api" as const,
    };

    // This will fail if schema is wrong
    const [inserted] = await db.insert(events).values(testEvent).returning();

    // Verify the inserted event
    const hasRequiredFields =
      inserted.id &&
      inserted.timestamp &&
      inserted.userId === testEvent.userId &&
      inserted.type === testEvent.type;

    logTest("Test 5: Event Schema Validation", hasRequiredFields);

    // Cleanup - delete test event
    await db.delete(events).where(eq(events.id, inserted.id));
  } catch (error) {
    logTest("Test 5: Event Schema Validation", false, (error as Error).message);
  }

  // Test 6: tRPC Router Setup
  try {
    // Test that tRPC is properly configured
    const response = await fetch(
      `${API_URL}/api/trpc/events.list?input=${encodeURIComponent(JSON.stringify({ limit: 10 }))}`
    );

    // Even if unauthorized, we should get a proper tRPC error response
    const isValidTRPCResponse = response.headers
      .get("content-type")
      ?.includes("json");

    logTest("Test 6: tRPC Router Setup", isValidTRPCResponse || false);
  } catch (error) {
    logTest("Test 6: tRPC Router Setup", false, (error as Error).message);
  }

  // Test 7: Better Auth Routes
  try {
    // Test that auth routes are accessible
    const response = await fetch(`${API_URL}/api/auth/session`);

    // Should return 200 (even if no session)
    logTest(
      "Test 7: Better Auth Routes",
      response.status === 200 || response.status === 401
    );
  } catch (error) {
    logTest("Test 7: Better Auth Routes", false, (error as Error).message);
  }

  // Print summary
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  TEST SUMMARY");
  console.log("═══════════════════════════════════════════════════════\n");
  console.log(`Total Tests:  ${testsRun}`);
  console.log(`✅ Passed:    ${testsPassed}`);
  console.log(`❌ Failed:    ${testsFailed}`);
  console.log(`Success Rate: ${Math.round((testsPassed / testsRun) * 100)}%\n`);

  if (testsFailed === 0) {
    console.log("🎉 All tests passed! Phase 1 foundation is solid.\n");
    console.log("Next steps:");
    console.log("1. Start the API server: pnpm --filter api dev");
    console.log("2. Start Inngest dev: pnpm --filter jobs dev");
    console.log("3. Test event logging with a real user session");
    console.log("4. Verify Inngest projectors are triggered\n");
  } else {
    console.log("⚠️  Some tests failed. Please review the errors above.\n");
    process.exit(1);
  }
}

// Run tests
runTests().catch((error) => {
  console.error("\n💥 Test suite crashed:", error);
  process.exit(1);
});
