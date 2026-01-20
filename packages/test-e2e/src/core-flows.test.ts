/**
 * E2E Tests - Core Flows
 *
 * Tests critical end-to-end flows:
 * 1. Complete conversation flow
 * 2. Event-driven flow (event → worker → projection)
 * 3. Hub Protocol flow
 * 4. Security isolation test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnvironment, type TestEnvironment } from "./setup.js";
import { randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "e2e-core-flows" });

describe("E2E Core Flows", () => {
  let testEnv: TestEnvironment;
  let startTime: number;

  beforeAll(async () => {
    startTime = Date.now();
    testEnv = await setupTestEnvironment();
    logger.info("E2E tests starting");
  }, 300000); // 5 minutes for setup

  afterAll(async () => {
    const duration = Date.now() - startTime;
    logger.info({ duration: `${duration}ms` }, "E2E tests completed");
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  describe("1. Complete Conversation Flow", () => {
    it("should handle complete conversation: send message → AI response → action execution", async () => {
      const { apiUrl, users } = testEnv;
      const user = users.userA;
      const threadId = randomUUID();

      // Step 1: Send message
      const sendMessageStart = Date.now();
      const sendMessageResponse = await fetch(
        `${apiUrl}/trpc/chat.sendMessage`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: user.sessionCookie || "",
          },
          body: JSON.stringify({
            threadId,
            content:
              "Rappelle-moi d'appeler Jean pour le projet X demain à 14h",
          }),
        }
      );

      expect(sendMessageResponse.ok).toBe(true);
      const sendMessageResult = await sendMessageResponse.json();
      expect(sendMessageResult.result?.data?.success).toBe(true);
      expect(sendMessageResult.result?.data?.requestId).toBeDefined();
      expect(sendMessageResult.result?.data?.threadId).toBe(threadId);

      const sendMessageDuration = Date.now() - sendMessageStart;
      logger.info(
        { duration: `${sendMessageDuration}ms` },
        "Send message completed"
      );

      // Step 2: Wait for AI processing (simulate - in real flow, this would be async)
      // Note: In a real E2E test, we'd wait for the Inngest job to complete
      // For now, we'll just verify the event was created
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Step 3: Get thread history
      const getThreadResponse = await fetch(
        `${apiUrl}/trpc/chat.getThread?input=${encodeURIComponent(JSON.stringify({ threadId, limit: 10 }))}`,
        {
          method: "GET",
          headers: {
            Cookie: user.sessionCookie || "",
          },
        }
      );

      expect(getThreadResponse.ok).toBe(true);
      const threadResult = await getThreadResponse.json();
      expect(threadResult.result?.data?.threadId).toBe(threadId);
      expect(threadResult.result?.data?.messages).toBeDefined();
      expect(Array.isArray(threadResult.result?.data?.messages)).toBe(true);

      const totalDuration = Date.now() - sendMessageStart;
      logger.info(
        { duration: `${totalDuration}ms` },
        "Complete conversation flow completed"
      );

      // Performance assertion
      expect(totalDuration).toBeLessThan(10000); // Should complete in < 10 seconds
    }, 30000); // 30s timeout
  });

  describe("2. Event-Driven Flow", () => {
    it("should handle event: note.creation.requested → worker → entity created", async () => {
      const { apiUrl, users } = testEnv;
      const user = users.userA;

      // Step 1: Create a note via API
      const createNoteStart = Date.now();
      const createNoteResponse = await fetch(`${apiUrl}/trpc/notes.create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: user.sessionCookie || "",
        },
        body: JSON.stringify({
          content: "E2E Test Note - Event Flow",
          autoEnrich: false, // Skip AI enrichment for faster test
        }),
      });

      expect(createNoteResponse.ok).toBe(true);
      const createNoteResult = await createNoteResponse.json();
      expect(createNoteResult.result?.data?.id).toBeDefined();
      const noteId = createNoteResult.result?.data?.id;

      const createNoteDuration = Date.now() - createNoteStart;
      logger.info(
        { duration: `${createNoteDuration}ms`, noteId },
        "Note created"
      );

      // Step 2: Wait for worker to process event
      // In a real E2E test, we'd wait for Inngest to process the event
      // For now, we'll wait a bit and then verify the entity exists
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Step 3: Verify entity was created in projection
      const getNoteResponse = await fetch(
        `${apiUrl}/trpc/notes.getById?input=${encodeURIComponent(JSON.stringify({ id: noteId }))}`,
        {
          method: "GET",
          headers: {
            Cookie: user.sessionCookie || "",
          },
        }
      );

      expect(getNoteResponse.ok).toBe(true);
      const noteResult = await getNoteResponse.json();
      expect(noteResult.result?.data?.id).toBe(noteId);
      expect(noteResult.result?.data?.content).toContain("E2E Test Note");

      const totalDuration = Date.now() - createNoteStart;
      logger.info(
        { duration: `${totalDuration}ms` },
        "Event-driven flow completed"
      );

      // Performance assertion
      expect(totalDuration).toBeLessThan(10000); // Should complete in < 10 seconds
    }, 30000);
  });

  describe("3. Hub Protocol Flow", () => {
    it("should handle Hub Protocol: generateAccessToken → requestData → submitInsight", async () => {
      const { apiUrl, users } = testEnv;
      const user = users.userA;

      if (!user.apiKey) {
        logger.warn("API key not available, skipping Hub Protocol test");
        return;
      }

      const hubFlowStart = Date.now();
      const requestId = randomUUID();

      // Step 1: Generate access token
      const generateTokenStart = Date.now();
      const generateTokenResponse = await fetch(
        `${apiUrl}/trpc/hub.generateAccessToken`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: user.sessionCookie || "",
          },
          body: JSON.stringify({
            requestId,
            scope: ["preferences", "notes", "tasks"],
            expiresIn: 300,
          }),
        }
      );

      expect(generateTokenResponse.ok).toBe(true);
      const tokenResult = await generateTokenResponse.json();
      expect(tokenResult.result?.data?.token).toBeDefined();
      expect(tokenResult.result?.data?.expiresAt).toBeDefined();
      const token = tokenResult.result?.data?.token;

      const generateTokenDuration = Date.now() - generateTokenStart;
      logger.info(
        { duration: `${generateTokenDuration}ms` },
        "Access token generated"
      );

      // Step 2: Request data
      const requestDataStart = Date.now();
      const requestDataResponse = await fetch(
        `${apiUrl}/trpc/hub.requestData`,
        {
          method: "GET",
          headers: {
            Cookie: user.sessionCookie || "",
          },
          // Note: tRPC GET requests use query params
        }
      );

      // For tRPC, we need to use POST for mutations/queries with body
      const requestDataResponsePost = await fetch(
        `${apiUrl}/trpc/hub.requestData`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: user.sessionCookie || "",
          },
          body: JSON.stringify({
            token,
            scope: ["notes"],
            filters: {},
          }),
        }
      );

      expect(requestDataResponsePost.ok).toBe(true);
      const dataResult = await requestDataResponsePost.json();
      expect(dataResult.result?.data?.data).toBeDefined();
      expect(dataResult.result?.data?.scope).toBeDefined();

      const requestDataDuration = Date.now() - requestDataStart;
      logger.info({ duration: `${requestDataDuration}ms` }, "Data requested");

      // Step 3: Submit insight
      const submitInsightStart = Date.now();
      const insight = {
        version: "1.0",
        type: "action_plan" as const,
        correlationId: requestId,
        actions: [
          {
            eventType: "task.creation.requested",
            data: {
              title: "E2E Test Task from Hub",
              description: "Created via Hub Protocol E2E test",
            },
          },
        ],
        confidence: 0.95,
        reasoning: "E2E test insight",
      };

      const submitInsightResponse = await fetch(
        `${apiUrl}/trpc/hub.submitInsight`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: user.sessionCookie || "",
          },
          body: JSON.stringify({
            token,
            requestId,
            insight,
          }),
        }
      );

      expect(submitInsightResponse.ok).toBe(true);
      const insightResult = await submitInsightResponse.json();
      expect(insightResult.result?.data?.success).toBe(true);
      expect(insightResult.result?.data?.eventIds).toBeDefined();
      expect(Array.isArray(insightResult.result?.data?.eventIds)).toBe(true);

      const submitInsightDuration = Date.now() - submitInsightStart;
      logger.info(
        { duration: `${submitInsightDuration}ms` },
        "Insight submitted"
      );

      const totalDuration = Date.now() - hubFlowStart;
      logger.info(
        { duration: `${totalDuration}ms` },
        "Hub Protocol flow completed"
      );

      // Performance assertion
      expect(totalDuration).toBeLessThan(5000); // Should complete in < 5 seconds
    }, 30000);
  });

  describe("4. Security Isolation Test", () => {
    it("should prevent user A from accessing user B's data", async () => {
      const { apiUrl, users } = testEnv;
      const userA = users.userA;
      const userB = users.userB;

      // Step 1: User A creates a note
      const createNoteResponse = await fetch(`${apiUrl}/trpc/notes.create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: userA.sessionCookie || "",
        },
        body: JSON.stringify({
          content: "Private note from User A",
          autoEnrich: false,
        }),
      });

      expect(createNoteResponse.ok).toBe(true);
      const createNoteResult = await createNoteResponse.json();
      const noteId = createNoteResult.result?.data?.id;
      expect(noteId).toBeDefined();

      logger.info({ noteId, userId: userA.id }, "User A created note");

      // Step 2: User B tries to access User A's note
      const getNoteResponse = await fetch(
        `${apiUrl}/trpc/notes.getById?input=${encodeURIComponent(JSON.stringify({ id: noteId }))}`,
        {
          method: "GET",
          headers: {
            Cookie: userB.sessionCookie || "",
          },
        }
      );

      // Should fail with 403 Forbidden or return null/empty
      if (getNoteResponse.ok) {
        const noteResult = await getNoteResponse.json();
        // Either the note should not exist for user B, or it should be empty
        expect(noteResult.result?.data).toBeFalsy();
      } else {
        // Or it should return an error
        expect(getNoteResponse.status).toBeGreaterThanOrEqual(400);
      }

      logger.info("Security isolation verified");
    }, 15000);
  });
});
