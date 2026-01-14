/**
 * E2E Tests - Hub Protocol Integration
 *
 * Tests external intelligence service integration:
 * 1. Generate access token
 * 2. Query user data
 * 3. Submit entity via Hub Protocol
 * 4. Verify proposal flow triggered
 * 5. Full intelligence service workflow
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnvironment, type TestEnvironment } from "./setup.js";
import {
  createTestClient,
  testDataFactory,
  DatabaseTestHelpers,
  wait,
  retryUntil,
} from "./test-harness.js";
import { createLogger } from "@synap-core/core";
import { db } from "@synap/database";
import { randomUUID } from "crypto";

const logger = createLogger({ module: "e2e-hub-protocol" });

describe("E2E Hub Protocol", () => {
  let testEnv: TestEnvironment;
  let testClient: any;
  let dbHelpers: DatabaseTestHelpers;
  let testWorkspaceId: string;
  let accessToken: string;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
    testClient = createTestClient(testEnv.apiUrl, testEnv.users.userA);
    dbHelpers = new DatabaseTestHelpers(db);

    // Create workspace for tests
    const workspace = await testClient.client.workspaces.create.mutate(
      testDataFactory.workspace({ settings: { aiAutoApprove: false } })
    );
    testWorkspaceId = workspace.id;

    logger.info("Hub Protocol tests starting");
  }, 300000);

  afterAll(async () => {
    if (testWorkspaceId) {
      await dbHelpers.cleanup(testWorkspaceId);
    }
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  describe("1. Token Generation", () => {
    it("should generate access token with specified scopes", async () => {
      const requestId = randomUUID();
      const scopes = ["entities:read", "entities:write"];

      const result = await testClient.client.hub.generateAccessToken.mutate({
        requestId,
        scopes,
        expiresIn: 300, // 5 minutes
      });

      expect(result.token).toBeDefined();
      expect(result.expiresAt).toBeDefined();
      expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());

      accessToken = result.token;
      logger.info({ requestId }, "Access token generated");
    }, 10000);

    it("should validate token expiration", async () => {
      const requestId = randomUUID();

      // Generate short-lived token
      const result = await testClient.client.hub.generateAccessToken.mutate({
        requestId,
        scopes: ["entities:read"],
        expiresIn: 1, // 1 second
      });

      // Wait for expiration
      await wait(2000);

      // Try to use expired token
      try {
        await testClient.client.hub.queryEntities.query({
          token: result.token,
          filters: {},
        });
        fail("Expected token expiration error");
      } catch (error: any) {
        expect(error.message).toContain("expired");
        logger.info("Token expiration validated");
      }
    }, 10000);
  });

  describe("2. Data Querying", () => {
    it("should query entities with valid token", async () => {
      // Create some test entities first
      await testClient.client.entities.create.mutate({
        workspaceId: testWorkspaceId,
        ...testDataFactory.entity("note", { title: "Hub Protocol Note 1" }),
      });
      await testClient.client.entities.create.mutate({
        workspaceId: testWorkspaceId,
        ...testDataFactory.entity("task", { title: "Hub Protocol Task 1" }),
      });

      await wait(2000);

      // Query via Hub Protocol
      const result = await testClient.client.hub.queryEntities.query({
        token: accessToken,
        filters: { workspaceId: testWorkspaceId },
      });

      expect(result.entities).toBeDefined();
      expect(Array.isArray(result.entities)).toBe(true);
      expect(result.entities.length).toBeGreaterThanOrEqual(2);

      logger.info({ count: result.entities.length }, "Entities queried successfully");
    }, 15000);

    it("should respect scope limitations", async () => {
      // Generate token with limited scope
      const limitedToken = await testClient.client.hub.generateAccessToken.mutate({
        requestId: randomUUID(),
        scopes: ["entities:read"], // No write permission
        expiresIn: 300,
      });

      // Try to create entity with read-only token
      try {
        await testClient.client.hub.createEntity.mutate({
          token: limitedToken.token,
          entity: testDataFactory.entity("note", { title: "Should Fail" }),
        });
        fail("Expected scope error");
      } catch (error: any) {
        expect(error.message).toContain("scope");
        logger.info("Scope limitation enforced");
      }
    }, 10000);
  });

  describe("3. Entity Creation via Hub Protocol", () => {
    it("should create entity and trigger proposal flow", async () => {
      // Generate token with write access
      const writeToken = await testClient.client.hub.generateAccessToken.mutate({
        requestId: randomUUID(),
        scopes: ["entities:read", "entities:write"],
        expiresIn: 300,
      });

      const entityData = testDataFactory.aiEntity("note", {
        title: "Hub Protocol AI Note",
        metadata: {
          source: "ai",
          serviceName: "test-intelligence-service",
        },
      });

      const result = await testClient.client.hub.createEntity.mutate({
        token: writeToken.token,
        workspaceId: testWorkspaceId,
        entity: entityData,
      });

      expect(result.id).toBeDefined();
      logger.info({ entityId: result.id }, "Entity creation requested via Hub");

      await wait(2000);

      // Since aiAutoApprove=false, should create proposal
      const proposal = await retryUntil(
        () => dbHelpers.getProposal(result.id),
        (p) => p !== null,
        { timeout: 5000 }
      );

      expect(proposal).toBeDefined();
      expect(proposal.status).toBe("pending");
      expect(proposal.request.source).toBe("ai");

      logger.info({ proposalId: proposal.id }, "Proposal created via Hub Protocol");
    }, 20000);

    it("should create entity directly when aiAutoApprove=true", async () => {
      // Enable auto-approve
      await testClient.client.workspaces.updateSettings.mutate({
        workspaceId: testWorkspaceId,
        settings: { aiAutoApprove: true },
      });

      const writeToken = await testClient.client.hub.generateAccessToken.mutate({
        requestId: randomUUID(),
        scopes: ["entities:write"],
        expiresIn: 300,
      });

      const entityData = testDataFactory.aiEntity("task", {
        title: "Hub Protocol Auto-Approved Task",
      });

      const result = await testClient.client.hub.createEntity.mutate({
        token: writeToken.token,
        workspaceId: testWorkspaceId,
        entity: entityData,
      });

      await wait(2000);

      // Should be created directly
      const hasEntity = await retryUntil(
        () => dbHelpers.hasEntity(result.id),
        (exists) => exists,
        { timeout: 5000 }
      );
      expect(hasEntity).toBe(true);

      // No proposal
      const hasProposal = await dbHelpers.hasProposal(result.id);
      expect(hasProposal).toBe(false);

      logger.info("Entity auto-approved via Hub Protocol");
    }, 20000);
  });

  describe("4. Batch Operations", () => {
    it("should handle batch entity creation efficiently", async () => {
      const writeToken = await testClient.client.hub.generateAccessToken.mutate({
        requestId: randomUUID(),
        scopes: ["entities:write"],
        expiresIn: 300,
      });

      const entities = Array.from({ length: 3 }, (_, i) =>
        testDataFactory.aiEntity("note", {
          title: `Batch Hub Note ${i + 1}`,
        })
      );

      const startTime = Date.now();
      const results = await Promise.all(
        entities.map((entity) =>
          testClient.client.hub.createEntity.mutate({
            token: writeToken.token,
            workspaceId: testWorkspaceId,
            entity,
          })
        )
      );

      await wait(3000);

      // All should create proposals (aiAutoApprove still true from previous test)
      for (const result of results) {
        const hasEntity = await dbHelpers.hasEntity(result.id);
        expect(hasEntity).toBe(true);
      }

      const duration = Date.now() - startTime;
      logger.info({ count: entities.length, duration: `${duration}ms` }, "Batch creation completed");

      expect(duration).toBeLessThan(15000);
    }, 30000);
  });

  describe("5. Full Intelligence Service Workflow", () => {
    it("should simulate complete external service interaction", async () => {
      // Simulate intelligence service workflow:
      // 1. Service generates token
      // 2. Service queries user data
      // 3. Service processes with AI
      // 4. Service submits insights
      // 5. User approves
      // 6. Entities created

      const requestId = randomUUID();

      // Step 1: Generate token
      const tokenResult = await testClient.client.hub.generateAccessToken.mutate({
        requestId,
        scopes: ["entities:read", "entities:write"],
        expiresIn: 600,
      });

      logger.info("Intelligence service: Token generated");

      // Step 2: Query context
      const contextResult = await testClient.client.hub.queryEntities.query({
        token: tokenResult.token,
        filters: { workspaceId: testWorkspaceId, type: "note" },
      });

      logger.info({
        count: contextResult.entities.length,
      }, "Intelligence service: Context retrieved");

      // Step 3: Simulate AI processing (skip for test)
      
      // Step 4: Submit insights
      await testClient.client.workspaces.updateSettings.mutate({
        workspaceId: testWorkspaceId,
        settings: { aiAutoApprove: false },
      });

      const insightEntity = testDataFactory.aiEntity("task", {
        title: "AI Insight: Follow up on project",
        metadata: {
          source: "ai",
          serviceName: "test-intelligence-service",
          confidence: 0.92,
          reasoning: "Based on note analysis",
        },
      });

      const createResult = await testClient.client.hub.createEntity.mutate({
        token: tokenResult.token,
        workspaceId: testWorkspaceId,
        entity: insightEntity,
      });

      logger.info({ entityId: createResult.id }, "Intelligence service: Insight submitted");

      await wait(2000);

      // Step 5: User approves proposal
      const proposal = await dbHelpers.getProposal(createResult.id);
      expect(proposal).toBeDefined();

      await testClient.client.proposals.approve.mutate({
        proposalId: proposal.id,
      });

      logger.info("User: Proposal approved");

      await wait(2000);

      // Step 6: Verify entity created
      const hasEntity = await retryUntil(
        () => dbHelpers.hasEntity(createResult.id),
        (exists) => exists,
        { timeout: 5000 }
      );
      expect(hasEntity).toBe(true);

      logger.info("Complete intelligence service workflow successful");
    }, 45000);
  });
});
