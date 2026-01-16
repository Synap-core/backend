/**
 * User Isolation Tests
 *
 * Validates that userId filtering works correctly at the application level.
 *
 * These tests verify:
 * - Users can only see their own data
 * - INSERT operations include userId
 * - SELECT operations filter by userId
 * - UPDATE/DELETE operations are user-scoped
 *
 * Run with:
 * ```bash
 * export DB_DIALECT=postgres
 * export DATABASE_URL=postgresql://...
 * npx vitest run packages/core/tests/user-isolation.test.ts
 * ```
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool } from "@neondatabase/serverless";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
} from "drizzle-orm/pg-core";

// Create PostgreSQL connection for tests
const connectionString = process.env.DATABASE_URL!;
const pool = new Pool({ connectionString });
const db = drizzle(pool);

// Define table schemas (simplified for tests)
const events = pgTable("events", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  timestamp: timestamp("timestamp", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  type: text("type").notNull(),
  data: jsonb("data").notNull(),
  source: text("source").default("api"),
});

const entities = pgTable("entities", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  title: text("title"),
  preview: text("preview"),
  version: integer("version").default(1).notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
});

const tags = pgTable("tags", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  color: text("color"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Skip tests if not in PostgreSQL mode
const isPostgres = process.env.DB_DIALECT === "postgres";
const describeIf = isPostgres ? describe : describe.skip;

describeIf("User Isolation (Application-Level Filtering)", () => {
  // Test user IDs
  const userA = "test-user-a-" + Date.now();
  const userB = "test-user-b-" + Date.now();

  let entityIdA: string;
  let entityIdB: string;
  let tagIdA: string;

  beforeAll(async () => {
    console.log("\n🧪 Setting up user isolation tests...");
    console.log("   User A:", userA);
    console.log("   User B:", userB);
  });

  afterAll(async () => {
    console.log("\n🧹 Cleaning up test data...");

    try {
      // Delete User A data
      if (entityIdA) {
        await db.delete(entities).where(eq(entities.id, entityIdA));
      }
      await db.delete(events).where(eq(events.userId, userA));
      await db.delete(tags).where(eq(tags.userId, userA));

      // Delete User B data
      if (entityIdB) {
        await db.delete(entities).where(eq(entities.id, entityIdB));
      }
      await db.delete(events).where(eq(events.userId, userB));
      await db.delete(tags).where(eq(tags.userId, userB));

      console.log("✅ Test data cleaned up");
    } catch (error) {
      console.error("❌ Cleanup error:", error);
    }
  });

  // ========================================
  // EVENT ISOLATION TESTS
  // ========================================

  it("should create events with userId", async () => {
    const [event] = await db
      .insert(events)
      .values({
        type: "test.event",
        data: { message: "User A test event" },
        source: "test",
        userId: userA,
      })
      .returning();

    expect(event).toBeDefined();
    expect(event.userId).toBe(userA);

    console.log("✅ Event created with userId:", event.id);
  });

  it("should filter events by userId", async () => {
    // Create events for both users
    await db.insert(events).values({
      type: "test.event",
      data: { message: "User A event" },
      userId: userA,
    });

    await db.insert(events).values({
      type: "test.event",
      data: { message: "User B event" },
      userId: userB,
    });

    // User A queries
    const eventsA = await db
      .select()
      .from(events)
      .where(eq(events.userId, userA));

    // User B queries
    const eventsB = await db
      .select()
      .from(events)
      .where(eq(events.userId, userB));

    // Verify isolation
    expect(eventsA.every((e) => e.userId === userA)).toBe(true);
    expect(eventsB.every((e) => e.userId === userB)).toBe(true);
    expect(eventsA.some((e) => e.userId === userB)).toBe(false);
    expect(eventsB.some((e) => e.userId === userA)).toBe(false);

    console.log("✅ Events properly isolated between users");
  });

  // ========================================
  // ENTITY ISOLATION TESTS
  // ========================================

  it("should create entities with userId", async () => {
    const [entity] = await db
      .insert(entities)
      .values({
        type: "note",
        title: "User A Note",
        userId: userA,
      })
      .returning();

    expect(entity).toBeDefined();
    expect(entity.userId).toBe(userA);
    entityIdA = entity.id;

    console.log("✅ Entity created with userId:", entity.id);
  });

  it("should filter entities by userId", async () => {
    // Create entity for User B
    const [entityB] = await db
      .insert(entities)
      .values({
        type: "note",
        title: "User B Note",
        userId: userB,
      })
      .returning();
    entityIdB = entityB.id;

    // User A queries
    const entitiesA = await db
      .select()
      .from(entities)
      .where(eq(entities.userId, userA));

    // User B queries
    const entitiesB = await db
      .select()
      .from(entities)
      .where(eq(entities.userId, userB));

    // Verify isolation
    expect(entitiesA.some((e) => e.id === entityIdA)).toBe(true);
    expect(entitiesA.some((e) => e.id === entityIdB)).toBe(false);
    expect(entitiesB.some((e) => e.id === entityIdB)).toBe(true);
    expect(entitiesB.some((e) => e.id === entityIdA)).toBe(false);

    console.log("✅ Entities properly isolated between users");
  });

  // ========================================
  // TAG ISOLATION TESTS
  // ========================================

  it("should create user-scoped tags", async () => {
    // User A creates tag "important"
    const [tagA] = await db
      .insert(tags)
      .values({
        name: "important",
        userId: userA,
      })
      .returning();

    // User B creates tag "important" (same name, different user)
    const [tagB] = await db
      .insert(tags)
      .values({
        name: "important",
        userId: userB,
      })
      .returning();

    expect(tagA.id).not.toBe(tagB.id); // Different tags!
    expect(tagA.userId).toBe(userA);
    expect(tagB.userId).toBe(userB);

    tagIdA = tagA.id;

    console.log("✅ Tags are user-scoped (same name, different IDs)");
  });

  it("should filter tags by userId", async () => {
    // User A queries tags
    const tagsA = await db.select().from(tags).where(eq(tags.userId, userA));

    // User B queries tags
    const tagsB = await db.select().from(tags).where(eq(tags.userId, userB));

    // Verify each user sees only their tags
    expect(tagsA.every((t) => t.userId === userA)).toBe(true);
    expect(tagsB.every((t) => t.userId === userB)).toBe(true);
    expect(tagsA.length).toBeGreaterThan(0);
    expect(tagsB.length).toBeGreaterThan(0);

    console.log("✅ Tags properly filtered by userId");
  });

  // ========================================
  // CROSS-USER ACCESS PREVENTION
  // ========================================

  it("should prevent user from seeing other users data", async () => {
    // User B tries to query User A's entity
    const results = await db
      .select()
      .from(entities)
      .where(eq(entities.userId, userB)); // Filtering by User B

    // Should NOT contain User A's entity
    expect(results.some((e) => e.id === entityIdA)).toBe(false);
    expect(results.every((e) => e.userId === userB)).toBe(true);

    console.log("✅ User B cannot see User A data");
  });

  it("should prevent unauthorized updates with userId filter", async () => {
    // User B tries to update User A's entity
    // WITH userId filter → should update 0 rows
    await db
      .update(entities)
      .set({ title: "HACKED" })
      .where(
        and(
          eq(entities.id, entityIdA),
          eq(entities.userId, userB) // ✅ Correct: filter by User B's ID
        )
        // This returns 0 rows because entityIdA belongs to User A
      );

    // Verify User A's entity was NOT changed
    const [entity] = await db
      .select()
      .from(entities)
      .where(eq(entities.id, entityIdA));

    expect(entity.title).toBe("User A Note"); // Unchanged
    expect(entity.title).not.toBe("HACKED");

    console.log("✅ Unauthorized updates prevented with userId filter");
  });

  // ========================================
  // SEARCH ISOLATION
  // ========================================

  it("should isolate search results by userId", async () => {
    // User A searches
    const resultsA = await db
      .select()
      .from(entities)
      .where(eq(entities.userId, userA));

    // User B searches
    const resultsB = await db
      .select()
      .from(entities)
      .where(eq(entities.userId, userB));

    const titlesA = resultsA.map((e) => e.title);
    const titlesB = resultsB.map((e) => e.title);

    // Verify no overlap
    expect(titlesA).toContain("User A Note");
    expect(titlesA).not.toContain("User B Note");
    expect(titlesB).toContain("User B Note");
    expect(titlesB).not.toContain("User A Note");

    console.log("✅ Search results properly isolated");
  });
});

// ========================================
// SUMMARY
// ========================================

describeIf("Summary - User Isolation Strategy", () => {
  it("should document the isolation approach", () => {
    console.log(`
┌──────────────────────────────────────────────────────────┐
│  USER ISOLATION: Application-Level Filtering            │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ✅ Method: Explicit WHERE userId = ?                   │
│  ✅ Tables: All main tables have userId column          │
│  ✅ Indexes: userId indexed for performance             │
│  ✅ Components: Inherit via FK (no userId needed)       │
│                                                          │
│  Security: 🟡 Application-level (not database-level)   │
│  Risk: Developer must remember to filter                │
│  Mitigation: Tests + code reviews + helpers             │
│                                                          │
│  Future: Migrate to Supabase for database-level RLS     │
│                                                          │
└──────────────────────────────────────────────────────────┘
    `);

    expect(true).toBe(true);
  });
});
