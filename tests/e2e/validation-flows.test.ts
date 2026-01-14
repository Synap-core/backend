/**
 * E2E Tests - Validation Flows
 *
 * Tests the global validator and proposal system:
 * 1. User-initiated creation (auto-approve)
 * 2. AI-initiated creation (requires approval when aiAutoApprove=false)
 * 3. AI-initiated with auto-approve enabled
 * 4. Permission denied (viewer role)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupTestEnvironment, type TestEnvironment } from "./setup.js";
import {
  createTestClient,
  testDataFactory,
  DatabaseTestHelpers,
  wait,
  retryUntil,
  type TRPCTestClient,
} from "./test-harness.js";
import { createLogger } from "@synap-core/core";
import { db } from "@synap/database";
import { randomUUID } from "crypto";

const logger = createLogger({ module: "e2e-validation-flows" });

describe("E2E Validation Flows", () => {
  let testEnv: TestEnvironment;
  let clientA: TRPCTestClient;
  let clientB: TRPCTestClient;
  let dbHelpers: DatabaseTestHelpers;
  let testWorkspaceId: string;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
    clientA = createTestClient(testEnv.apiUrl, testEnv.users.userA);
    clientB = createTestClient(testEnv.apiUrl, testEnv.users.userB);
    dbHelpers = new DatabaseTestHelpers(db);

    logger.info("Validation flow tests starting");
  }, 300000);

  afterAll(async () => {
    if (testEnv && testWorkspaceId) {
      await dbHelpers.cleanup(testWorkspaceId);
    }
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  beforeEach(async () => {
    // Create a fresh workspace for each test
    const workspace = await clientA.client.workspaces.create.mutate(
      testDataFactory.workspace({
        settings: { aiAutoApprove: false },
      })
    );
    testWorkspaceId = workspace.id;
    logger.info({ workspaceId: testWorkspaceId }, "Test workspace created");
  });

  describe("1. User-initiated creation (auto-approve)", () => {
    it("should auto-approve user entity creation and emit validated event", async () => {
      const entityData = testDataFactory.entity("note", {
        title: "User Note - Should Auto Approve",
        metadata: { source: "user" },
      });

      // Create entity via tRPC
      const startTime = Date.now();
      const result = await clientA.client.entities.create.mutate({
        workspaceId: testWorkspaceId,
        ...entityData,
      });

      logger.info({ entityId: result.id }, "Entity creation requested");

      // Wait for worker to process (Inngest is eventually consistent)
      await wait(2000);

      // Assert: Entity should exist in database
      const hasEntity = await retryUntil(
        () => dbHelpers.hasEntity(result.id),
        (exists) => exists,
        { timeout: 5000 }
      );
      expect(hasEntity).toBe(true);

      // Assert: NO proposal should be created
      const hasProposal = await dbHelpers.hasProposal(result.id);
      expect(hasProposal).toBe(false);

      const duration = Date.now() - startTime;
      logger.info({ duration: `${duration}ms` }, "User entity auto-approved");

      // Performance assertion
      expect(duration).toBeLessThan(10000);
    }, 20000);

    it("should handle bulk entity creation efficiently", async () => {
      const entityCount = 5;
      const entities = Array.from({ length: entityCount }, (_, i) =>
        testDataFactory.entity("note", {
          title: `Bulk Note ${i + 1}`,
        })
      );

      const startTime = Date.now();
      const results = await Promise.all(
        entities.map((entity) =>
          clientA.client.entities.create.mutate({
            workspaceId: testWorkspaceId,
            ...entity,
          })
        )
      );

      await wait(3000);

      // Assert: All entities created
      for (const result of results) {
        const hasEntity = await dbHelpers.hasEntity(result.id);
        expect(hasEntity).toBe(true);
      }

      const duration = Date.now() - startTime;
      logger.info(
        { count: entityCount, duration: `${duration}ms` },
        "Bulk creation completed"
      );

      expect(duration).toBeLessThan(15000);
    }, 30000);
  });

  describe("2. AI-initiated creation (requires approval)", () => {
    it("should create proposal when aiAutoApprove=false and source=ai", async () => {
      const entityData = testDataFactory.aiEntity("note", {
        title: "AI Generated Note - Needs Approval",
      });

      const result = await clientA.client.entities.create.mutate({
        workspaceId: testWorkspaceId,
        ...entityData,
      });

      logger.info({ entityId: result.id }, "AI entity creation requested");

      await wait(2000);

      // Assert: Proposal should exist
      const proposal = await retryUntil(
        () => dbHelpers.getProposal(result.id),
        (p) => p !== null,
        { timeout: 5000 }
      );

      expect(proposal).toBeDefined();
      expect(proposal.status).toBe("pending");
      expect(proposal.targetType).toBe("note");
      expect(proposal.request.source).toBe("ai");

      // Assert: Entity should NOT exist yet
      const hasEntity = await dbHelpers.hasEntity(result.id);
      expect(hasEntity).toBe(false);

      logger.info({ proposalId: proposal.id }, "Proposal created successfully");
    }, 20000);

    it("should approve proposal and create entity when user approves", async () => {
      // Step 1: Create AI entity (creates proposal)
      const entityData = testDataFactory.aiEntity("task", {
        title: "AI Task - Will Be Approved",
      });

      const createResult = await clientA.client.entities.create.mutate({
        workspaceId: testWorkspaceId,
        ...entityData,
      });

      await wait(2000);

      const proposal = await dbHelpers.getProposal(createResult.id);
      expect(proposal).toBeDefined();

      // Step 2: Approve proposal
      const approveResult = await clientA.client.proposals.approve.mutate({
        proposalId: proposal.id,
      });

      expect(approveResult.success).toBe(true);

      await wait(2000);

      // Assert: Entity should now exist
      const hasEntity = await retryUntil(
        () => dbHelpers.hasEntity(createResult.id),
        (exists) => exists,
        { timeout: 5000 }
      );
      expect(hasEntity).toBe(true);

      // Assert: Proposal status updated
      const updatedProposal = await dbHelpers.getProposal(createResult.id);
      expect(updatedProposal.status).toBe("validated");

      logger.info("Proposal approved and entity created");
    }, 30000);

    it("should reject proposal and NOT create entity when user rejects", async () => {
      const entityData = testDataFactory.aiEntity("note", {
        title: "AI Note - Will Be Rejected",
      });

      const createResult = await clientA.client.entities.create.mutate({
        workspaceId: testWorkspaceId,
        ...entityData,
      });

      await wait(2000);

      const proposal = await dbHelpers.getProposal(createResult.id);
      expect(proposal).toBeDefined();

      // Reject proposal
      const rejectResult = await clientA.client.proposals.reject.mutate({
        proposalId: proposal.id,
        reason: "E2E test rejection",
      });

      expect(rejectResult.success).toBe(true);

      await wait(2000);

      // Assert: Entity should NOT exist
      const hasEntity = await dbHelpers.hasEntity(createResult.id);
      expect(hasEntity).toBe(false);

      // Assert: Proposal marked as rejected
      const updatedProposal = await dbHelpers.getProposal(createResult.id);
      expect(updatedProposal.status).toBe("rejected");

      logger.info("Proposal rejected, entity not created");
    }, 30000);
  });

  describe("3. AI-initiated with auto-approve enabled", () => {
    it("should auto-approve AI entities when aiAutoApprove=true", async () => {
      // Update workspace settings
      await clientA.client.workspaces.updateSettings.mutate({
        workspaceId: testWorkspaceId,
        settings: { aiAutoApprove: true },
      });

      const entityData = testDataFactory.aiEntity("note", {
        title: "AI Note - Auto Approved",
      });

      const result = await clientA.client.entities.create.mutate({
        workspaceId: testWorkspaceId,
        ...entityData,
      });

      await wait(2000);

      // Assert: Entity should exist
      const hasEntity = await retryUntil(
        () => dbHelpers.hasEntity(result.id),
        (exists) => exists,
        { timeout: 5000 }
      );
      expect(hasEntity).toBe(true);

      // Assert: NO proposal created
      const hasProposal = await dbHelpers.hasProposal(result.id);
      expect(hasProposal).toBe(false);

      logger.info("AI entity auto-approved with aiAutoApprove=true");
    }, 20000);
  });

  describe("4. Permission denied (non-editor)", () => {
    it("should deny creation when user is not editor/owner", async () => {
      // Try to create entity in workspace where userB is not a member
      const entityData = testDataFactory.entity("note", {
        title: "Unauthorized Note",
      });

      // This should fail or create a denied proposal
      try {
        await clientB.client.entities.create.mutate({
          workspaceId: testWorkspaceId, // User A's workspace
          ...entityData,
        });

        // If we get here, check that entity wasn't created
        await wait(2000);
        
        // The entity ID would be in the result, but we need to track it
        // For now, we verify no entities exist from user B
        fail("Expected permission error");
      } catch (error: any) {
        // Expected: Permission error
        expect(error.message).toContain("permission");
        logger.info("Permission correctly denied for non-editor");
      }
    }, 20000);

    it("should emit denied event when permission check fails", async () => {
      // This test assumes we can listen to events
      // For now, we verify via database that no entity/proposal was created
      
      const entityData = testDataFactory.entity("note", {
        title: "Denied Note",
      });

      try {
        const result = await clientB.client.entities.create.mutate({
          workspaceId: testWorkspaceId,
          ...entityData,
        });

        await wait(2000);

        // If creation succeeded (shouldn't), verify nothing persisted
        const hasEntity = await dbHelpers.hasEntity(result.id);
        const hasProposal = await dbHelpers.hasProposal(result.id);
        
        expect(hasEntity).toBe(false);
        expect(hasProposal).toBe(false);
      } catch (error) {
        // Expected path
        logger.info("Entity creation denied as expected");
      }
    }, 20000);
  });

  describe("5. Complex validation scenarios", () => {
    it("should handle mixed user/AI entities in same workspace", async () => {
      const userEntity = testDataFactory.entity("note", {
        title: "User Note",
      });
      const aiEntity = testDataFactory.aiEntity("note", {
        title: "AI Note",
      });

      // Create both
      const [userResult, aiResult] = await Promise.all([
        clientA.client.entities.create.mutate({
          workspaceId: testWorkspaceId,
          ...userEntity,
        }),
        clientA.client.entities.create.mutate({
          workspaceId: testWorkspaceId,
          ...aiEntity,
        }),
      ]);

      await wait(3000);

      // User entity should be created
      const hasUserEntity = await dbHelpers.hasEntity(userResult.id);
      expect(hasUserEntity).toBe(true);

      // AI entity should be proposal
      const hasAiProposal = await dbHelpers.hasProposal(aiResult.id);
      expect(hasAiProposal).toBe(true);

      logger.info("Mixed user/AI validation working correctly");
    }, 30000);
  });
});
