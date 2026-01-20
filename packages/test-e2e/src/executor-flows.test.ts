/**
 * E2E Tests - Executor Flows
 *
 * Tests the Unified Execution Layer:
 * - Verifies that the 3-event flow works (Requested -> Validated -> Completed)
 * - Verifies that both Fast and Slow executors function correctly
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnvironment, type TestEnvironment } from "./setup.js";
import { createLogger } from "@synap-core/core";
import { db, EventRepository, tags, entities } from "@synap/database";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

const logger = createLogger({ module: "e2e-executor-flows" });

describe("E2E Executor Flows", () => {
  let testEnv: TestEnvironment;
  let eventRepo: EventRepository;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
    // We can use the DB directly for verification
    eventRepo = new EventRepository(db as any);
  }, 300000);

  afterAll(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  /**
   * Helper to wait for a specific event type on a subject
   */
  async function waitForEvent(
    eventType: string,
    subjectId: string,
    timeoutMs = 5000
  ) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // Accessing private query method via cast for testing
      const events = await (eventRepo as any).query({
        filters: { eventType, subjectId },
      });
      if (events.length > 0) return events[0];
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timeout waiting for event ${eventType} on ${subjectId}`);
  }

  describe("Fast Executors (Tags)", () => {
    it("should process tags.create: Requested -> Validated -> Completed", async () => {
      const { apiUrl, users } = testEnv;
      const user = users.userA;
      const tagName = `E2E Tag ${randomUUID().slice(0, 8)}`;

      // 1. Emit Request (via API simulation or direct DB if API not updated yet)
      // Since API might not be updated to use .requested yet in the codebase,
      // we'll check what the current API does.
      // Ideally, we hit the API. If the API is not yet refactored to emit .requested,
      // this test will fail on the first step.
      // Based on the plan, the router refactoring is NEXT.
      // So for this test to pass NOW, we should simulate the Router's job: emitting .requested manually.

      const tagId = randomUUID();
      logger.info(
        { tagId },
        "Simulating Router: Emitting tags.create.requested"
      );

      await eventRepo.append({
        id: randomUUID(),
        version: "v1",
        type: "tags.create.requested",
        subjectId: tagId,
        subjectType: "tag",
        data: { name: tagName, color: "#ff0000", id: tagId }, // include ID in data for simplicity
        userId: user.id,
        source: "api",
        timestamp: new Date(),
      });

      // 2. Wait for GlobalValidator to emit tags.create.validated
      logger.info("Waiting for .validated...");
      await waitForEvent("tags.create.validated", tagId);
      logger.info("Received .validated");

      // 3. Wait for TagsExecutor (Fast) to emit tags.create.completed
      logger.info("Waiting for .completed...");
      await waitForEvent("tags.create.completed", tagId);
      logger.info("Received .completed");

      // 4. Verify DB state
      const tag = await db.query.tags.findFirst({
        where: eq(tags.id, tagId),
      });
      expect(tag).toBeDefined();
      expect(tag?.name).toBe(tagName);
    });
  });

  describe("Slow Executors (Entities)", () => {
    it("should process entities.create: Requested -> Validated -> Completed", async () => {
      const { users } = testEnv;
      const user = users.userA;
      const entityId = randomUUID();
      const title = `E2E Entity ${randomUUID().slice(0, 8)}`;

      // 1. Simulate Router
      logger.info(
        { entityId },
        "Simulating Router: Emitting entities.create.requested"
      );
      await eventRepo.append({
        id: randomUUID(),
        version: "v1",
        type: "entities.create.requested",
        subjectId: entityId,
        subjectType: "entity",
        data: {
          entityType: "note",
          title,
          content: "Test Content",
          id: entityId,
        },
        userId: user.id,
        source: "api",
        timestamp: new Date(),
      });

      // 2. Wait for Validation
      await waitForEvent("entities.create.validated", entityId);

      // 3. Wait for Execution (Slow - involves steps)
      await waitForEvent("entities.create.completed", entityId, 10000);

      // 4. Verify DB
      const entity = await db.query.entities.findFirst({
        where: eq(entities.id, entityId),
      });
      expect(entity).toBeDefined();
      expect(entity?.title).toBe(title);
    });
  });
});
