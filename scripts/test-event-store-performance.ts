/**
 * Event Store Performance Test
 *
 * Phase 1: Validates the event store can handle high-volume writes
 *
 * This script:
 * 1. Generates 100,000 valid note.creation.requested events
 * 2. Inserts them into the Event Store (TimescaleDB)
 * 3. Measures write performance (events/second)
 * 4. Tests time-range queries
 *
 * Run with:
 *   pnpm build
 *   tsx scripts/test-event-store-performance.ts
 */

import { getEventRepository } from "@synap/database";
import { createSynapEvent } from "@synap/types";
import { randomUUID } from "node:crypto";

// ============================================================================
// CONFIGURATION
// ============================================================================

const EVENT_COUNT = 100_000;
const BATCH_SIZE = 1000; // Insert in batches for better performance

// ============================================================================
// SETUP
// ============================================================================

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("❌ DATABASE_URL environment variable is required");
  console.error("   Set it to your Neon PostgreSQL connection string");
  process.exit(1);
}

// Use the singleton event repository (it will use DATABASE_URL from env)
const eventRepo = getEventRepository();

// ============================================================================
// TEST FUNCTIONS
// ============================================================================

/**
 * Generate a batch of valid SynapEvents
 */
function generateEvents(
  count: number,
  userId: string,
): ReturnType<typeof createSynapEvent>[] {
  const events: ReturnType<typeof createSynapEvent>[] = [];

  for (let i = 0; i < count; i++) {
    const event = createSynapEvent({
      type: "note.creation.requested",
      data: {
        content: `Test note content ${i}. This is a sample note for performance testing.`,
        title: `Test Note ${i}`,
        tags: i % 10 === 0 ? ["important", "test"] : ["test"],
        inputType: "text",
        autoEnrich: i % 2 === 0,
        useRAG: i % 3 === 0,
      },
      userId,
      requestId: randomUUID(),
    });

    events.push(event);
  }

  return events;
}

/**
 * Test serial insertion (one by one)
 */
async function testSerialInsertion(
  events: ReturnType<typeof createSynapEvent>[],
): Promise<{
  duration: number;
  eventsPerSecond: number;
}> {
  console.log(`\n📝 Testing serial insertion (${events.length} events)...`);

  const startTime = Date.now();

  for (const event of events) {
    await eventRepo.append(event);
  }

  const duration = Date.now() - startTime;
  const eventsPerSecond = (events.length / duration) * 1000;

  return { duration, eventsPerSecond };
}

/**
 * Test batch insertion
 */
async function testBatchInsertion(
  events: ReturnType<typeof createSynapEvent>[],
): Promise<{
  duration: number;
  eventsPerSecond: number;
}> {
  console.log(
    `\n📦 Testing batch insertion (${events.length} events in batches of ${BATCH_SIZE})...`,
  );

  const startTime = Date.now();

  // Insert in batches
  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    await eventRepo.appendBatch(batch);

    if ((i + BATCH_SIZE) % 10000 === 0) {
      console.log(`   Inserted ${i + BATCH_SIZE} events...`);
    }
  }

  const duration = Date.now() - startTime;
  const eventsPerSecond = (events.length / duration) * 1000;

  return { duration, eventsPerSecond };
}

/**
 * Test time-range query
 */
async function testTimeRangeQuery(userId: string): Promise<{
  duration: number;
  eventCount: number;
}> {
  console.log(`\n🔍 Testing time-range query...`);

  const startTime = Date.now();
  const results = await eventRepo.getUserStream(userId, {
    days: 1,
    limit: 1000,
  });
  const duration = Date.now() - startTime;

  return { duration, eventCount: results.length };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("🚀 Event Store Performance Test");
  console.log("════════════════════════════════════════════════════════════");
  console.log(`Target: ${EVENT_COUNT.toLocaleString()} events`);
  console.log(`Database: ${databaseUrl.split("@")[1] || "Unknown"}`);
  console.log("════════════════════════════════════════════════════════════");

  const userId = randomUUID();

  try {
    // Generate events
    console.log(`\n⚙️  Generating ${EVENT_COUNT.toLocaleString()} events...`);
    const generateStart = Date.now();
    const events = generateEvents(EVENT_COUNT, userId);
    const generateTime = Date.now() - generateStart;
    console.log(`✅ Generated in ${generateTime}ms`);

    // Test 1: Serial insertion (small sample)
    const sampleSize = 100;
    const sampleEvents = events.slice(0, sampleSize);
    const serialResult = await testSerialInsertion(sampleEvents);
    console.log(
      `✅ Serial: ${serialResult.duration}ms (${serialResult.eventsPerSecond.toFixed(0)} events/sec)`,
    );

    // Test 2: Batch insertion (full set)
    const batchResult = await testBatchInsertion(events);
    console.log(
      `✅ Batch: ${batchResult.duration}ms (${batchResult.eventsPerSecond.toFixed(0)} events/sec)`,
    );

    // Test 3: Time-range query
    const queryResult = await testTimeRangeQuery(userId);
    console.log(
      `✅ Query: ${queryResult.duration}ms (found ${queryResult.eventCount} events)`,
    );

    // Summary
    console.log("\n📊 Performance Summary");
    console.log("════════════════════════════════════════════════════════════");
    console.log(
      `Serial Insertion:     ${serialResult.eventsPerSecond.toFixed(0)} events/sec`,
    );
    console.log(
      `Batch Insertion:      ${batchResult.eventsPerSecond.toFixed(0)} events/sec`,
    );
    console.log(
      `Time-Range Query:     ${queryResult.duration}ms (${queryResult.eventCount} events)`,
    );
    console.log("════════════════════════════════════════════════════════════");

    // Validation
    const targetEventsPerSecond = 10_000;
    if (batchResult.eventsPerSecond >= targetEventsPerSecond) {
      console.log(
        `\n✅ SUCCESS: Exceeded target of ${targetEventsPerSecond.toLocaleString()} events/sec`,
      );
    } else {
      console.log(
        `\n⚠️  WARNING: Below target of ${targetEventsPerSecond.toLocaleString()} events/sec`,
      );
    }

    // Cleanup (optional - comment out to keep test data)
    // Note: Cleanup requires direct database access, which is not exposed by EventRepository
    // For now, test data will remain in the database
    // To clean up manually: DELETE FROM events_timescale WHERE user_id = '<userId>';
    console.log(`\n📝 Test data user ID: ${userId}`);
    console.log("   To clean up manually, run:");
    console.log(`   DELETE FROM events_timescale WHERE user_id = '${userId}';`);
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    if (error instanceof Error) {
      console.error("   Error:", error.message);
      console.error("   Stack:", error.stack);
    }
    process.exit(1);
  }
}

main().catch(console.error);
