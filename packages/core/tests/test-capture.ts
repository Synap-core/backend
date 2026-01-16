/**
 * Simple Test Script for Thought Capture
 *
 * Tests the complete workflow without needing complex tRPC client setup
 */

import { db, events, entities } from "@synap/database";

console.log("🧪 Testing Thought Capture Workflow\n");

async function testCapture() {
  try {
    // Test API is running
    const healthCheck = await fetch("http://localhost:3000/health");
    const health = await healthCheck.json();
    console.log("✅ API Health:", health.status);

    // For now, let's test by directly inserting an event
    // (This simulates what the tRPC endpoint would do)
    console.log("\n📝 Simulating thought capture...");

    const thoughtContent = "Buy milk tomorrow at 3pm";

    // Insert event directly into database
    await db.insert(events).values({
      type: "api/thought.captured",
      data: {
        content: thoughtContent,
        context: {},
        capturedAt: new Date().toISOString(),
      },
      source: "api",
    });

    console.log("✅ Event logged to database");

    // Check events
    const allEvents = await db.select().from(events).all();
    console.log(`\n📊 Total events in database: ${allEvents.length}`);

    console.log("\n⏳ Now you need to:");
    console.log("   1. Start Inngest dev server: pnpm --filter jobs dev");
    console.log("   2. Inngest will pick up the event and process it");
    console.log(
      '   3. After ~5 seconds, check PostgreSQL: psql $DATABASE_URL -c "SELECT * FROM entities;"'
    );
    console.log(
      "\n💡 The AI will analyze and create a task entity automatically!"
    );
  } catch (error) {
    console.error("❌ Error:", (error as Error).message);
  }
}

testCapture();
