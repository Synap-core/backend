/**
 * Row-Level Security (RLS) Tests
 *
 * V1.0 Security Hardening: Validates that RLS properly isolates user data
 *
 * These tests verify that:
 * 1. Users can only access their own data
 * 2. Cross-user access is blocked by RLS
 * 3. RLS policies work for all tables
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  entities,
  events,
  tags,
  relations,
  setCurrentUser,
  clearCurrentUser,
} from "@synap/database";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

// Skip tests if not using PostgreSQL (RLS only works with PostgreSQL)
const isPostgres = process.env.DB_DIALECT === "postgres";

const describeIf = (condition: boolean) =>
  condition ? describe : describe.skip;

describeIf(isPostgres)("Row-Level Security (RLS) Tests", () => {
  const userA = "test-user-a-" + randomUUID();
  const userB = "test-user-b-" + randomUUID();

  // Test data
  let entityAId: string;
  let entityBId: string;
  let eventAId: string;
  let eventBId: string;
  let tagAId: string;
  let tagBId: string;

  beforeAll(async () => {
    // Create test data for both users
    // We need to set user context before inserting

    // Insert as User A
    await setCurrentUser(userA);
    const [entityA] = await db
      .insert(entities)
      .values({
        id: randomUUID(),
        userId: userA,
        type: "note",
        title: "User A Note",
        preview: "This is User A's note",
      })
      .returning();
    entityAId = entityA.id;

    const [eventA] = await db
      .insert(events)
      .values({
        id: randomUUID(),
        userId: userA,
        type: "entity.created",
        data: { entityId: entityAId },
        timestamp: new Date(),
      })
      .returning();
    eventAId = eventA.id;

    const [tagA] = await db
      .insert(tags)
      .values({
        id: randomUUID(),
        userId: userA,
        name: "user-a-tag",
        color: "#ff0000",
      })
      .returning();
    tagAId = tagA.id;

    // Insert as User B
    await setCurrentUser(userB);
    const [entityB] = await db
      .insert(entities)
      .values({
        id: randomUUID(),
        userId: userB,
        type: "note",
        title: "User B Note",
        preview: "This is User B's note",
      })
      .returning();
    entityBId = entityB.id;

    const [eventB] = await db
      .insert(events)
      .values({
        id: randomUUID(),
        userId: userB,
        type: "entity.created",
        data: { entityId: entityBId },
        timestamp: new Date(),
      })
      .returning();
    eventBId = eventB.id;

    const [tagB] = await db
      .insert(tags)
      .values({
        id: randomUUID(),
        userId: userB,
        name: "user-b-tag",
        color: "#0000ff",
      })
      .returning();
    tagBId = tagB.id;

    // Clear user context
    await clearCurrentUser();
  });

  afterAll(async () => {
    // Cleanup: Delete test data
    // We need to set user context to delete
    await setCurrentUser(userA);
    await db.delete(entities).where(eq(entities.id, entityAId));
    await db.delete(events).where(eq(events.id, eventAId));
    await db.delete(tags).where(eq(tags.id, tagAId));

    await setCurrentUser(userB);
    await db.delete(entities).where(eq(entities.id, entityBId));
    await db.delete(events).where(eq(events.id, eventBId));
    await db.delete(tags).where(eq(tags.id, tagBId));

    await clearCurrentUser();
  });

  describe("Entities Table RLS", () => {
    it("should allow User A to see only their own entities", async () => {
      await setCurrentUser(userA);

      const userAEntities = await db.select().from(entities);

      expect(userAEntities.length).toBe(1);
      expect(userAEntities[0].id).toBe(entityAId);
      expect(userAEntities[0].userId).toBe(userA);
      expect(userAEntities[0].title).toBe("User A Note");

      await clearCurrentUser();
    });

    it("should prevent User B from seeing User A entities", async () => {
      await setCurrentUser(userB);

      const userBEntities = await db.select().from(entities);

      expect(userBEntities.length).toBe(1);
      expect(userBEntities[0].id).toBe(entityBId);
      expect(userBEntities[0].userId).toBe(userB);
      // User B should NOT see User A's entity
      expect(userBEntities.find((e) => e.id === entityAId)).toBeUndefined();

      await clearCurrentUser();
    });

    it("should prevent User A from inserting entity with wrong user_id", async () => {
      await setCurrentUser(userA);

      // Try to insert an entity with userB's ID (should fail due to WITH CHECK policy)
      await expect(
        db.insert(entities).values({
          id: randomUUID(),
          userId: userB, // Wrong user_id!
          type: "note",
          title: "Hacked Note",
        })
      ).rejects.toThrow();

      await clearCurrentUser();
    });
  });

  describe("Events Table RLS", () => {
    it("should allow User A to see only their own events", async () => {
      await setCurrentUser(userA);

      const userAEvents = await db.select().from(events);

      expect(userAEvents.length).toBeGreaterThanOrEqual(1);
      expect(userAEvents.find((e) => e.id === eventAId)).toBeDefined();
      expect(userAEvents.find((e) => e.id === eventBId)).toBeUndefined();

      await clearCurrentUser();
    });

    it("should prevent User B from seeing User A events", async () => {
      await setCurrentUser(userB);

      const userBEvents = await db.select().from(events);

      expect(userBEvents.find((e) => e.id === eventBId)).toBeDefined();
      expect(userBEvents.find((e) => e.id === eventAId)).toBeUndefined();

      await clearCurrentUser();
    });
  });

  describe("Tags Table RLS", () => {
    it("should allow User A to see only their own tags", async () => {
      await setCurrentUser(userA);

      const userATags = await db.select().from(tags);

      expect(userATags.find((t) => t.id === tagAId)).toBeDefined();
      expect(userATags.find((t) => t.id === tagBId)).toBeUndefined();

      await clearCurrentUser();
    });

    it("should prevent cross-user tag access", async () => {
      await setCurrentUser(userB);

      const userBTags = await db.select().from(tags);

      expect(userBTags.find((t) => t.id === tagBId)).toBeDefined();
      expect(userBTags.find((t) => t.id === tagAId)).toBeUndefined();

      await clearCurrentUser();
    });
  });

  describe("RLS Without User Context", () => {
    it("should block all queries when no user context is set", async () => {
      // Don't set user context
      await clearCurrentUser();

      // All queries should return empty (RLS blocks everything)
      const entitiesResult = await db.select().from(entities);
      const eventsResult = await db.select().from(events);
      const tagsResult = await db.select().from(tags);

      // RLS should block all queries when app.current_user_id is not set
      // However, if the variable is not set, current_setting() returns NULL
      // and the policy condition fails, so no rows are returned
      expect(entitiesResult.length).toBe(0);
      expect(eventsResult.length).toBe(0);
      expect(tagsResult.length).toBe(0);
    });
  });

  describe("RLS Update Protection", () => {
    it("should prevent User B from updating User A entities", async () => {
      await setCurrentUser(userB);

      // Try to update User A's entity (should fail due to RLS)
      const updateResult = await db
        .update(entities)
        .set({ title: "Hacked Title" })
        .where(eq(entities.id, entityAId));

      // The update should affect 0 rows (RLS blocks it)
      // Note: Drizzle doesn't return affected rows count directly
      // We verify by checking that the entity wasn't actually updated
      await setCurrentUser(userA);
      const entityA = await db
        .select()
        .from(entities)
        .where(eq(entities.id, entityAId))
        .limit(1);

      expect(entityA[0].title).toBe("User A Note"); // Should still be original title

      await clearCurrentUser();
    });
  });

  describe("RLS Delete Protection", () => {
    it("should prevent User B from deleting User A entities", async () => {
      // Create a temporary entity for User A
      await setCurrentUser(userA);
      const [tempEntity] = await db
        .insert(entities)
        .values({
          id: randomUUID(),
          userId: userA,
          type: "note",
          title: "Temp Note",
        })
        .returning();
      const tempEntityId = tempEntity.id;

      // Try to delete as User B (should fail due to RLS)
      await setCurrentUser(userB);
      await db.delete(entities).where(eq(entities.id, tempEntityId));

      // Verify entity still exists (User B couldn't delete it)
      await setCurrentUser(userA);
      const stillExists = await db
        .select()
        .from(entities)
        .where(eq(entities.id, tempEntityId))
        .limit(1);

      expect(stillExists.length).toBe(1); // Entity should still exist

      // Cleanup: Delete as User A
      await db.delete(entities).where(eq(entities.id, tempEntityId));
      await clearCurrentUser();
    });
  });
});
