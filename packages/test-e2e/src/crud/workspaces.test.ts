/**
 * Workspaces CRUD Tests
 * 
 * Tests workspace operations through the event-driven flow:
 * - Create (async: .requested → validator → .validated)
 * - Read/List (sync: direct query)
 * - Update (async: validation flow)
 * - Delete (async: owner-only validation)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnvironment, type TestEnvironment } from "../setup.js";
import { waitForValidation, waitForEvent } from "../utils/event-waiter.js";
import { expectRequested, expectValidated, expectValidUUID } from "../utils/assertions.js";
import { randomUUID } from "crypto";

describe("Workspaces CRUD", () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
  }, 300000); // 5 minutes for setup

  afterAll(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  describe("Create Workspace (Async Validation)", () => {
    it("should create workspace via event flow", async () => {
      const { users } = testEnv;
      const userA = users.userA;

      // Step 1: Request workspace creation
      const createResponse = await userA.trpc.workspaces.create.mutate({
        name: "Test Workspace",
        type: "personal",
        description: "E2E test workspace",
      });

      // Should return "requested" status
      expectRequested(createResponse);

      // Step 2: Wait for validation (global validator should auto-approve for user)
      const validation = await waitForValidation("workspaces.create", {
        timeout: 10000,
      });

      // Should be validated (user has permission)
      expectValidated(validation);

      // Step 3: Verify workspace exists in database
      const workspaces = await userA.trpc.workspaces.list.query();
      expect(workspaces).toBeDefined();
      expect(Array.isArray(workspaces)).toBe(true);
      expect(workspaces.length).toBeGreaterThan(0);

      const createdWorkspace = workspaces.find(
        (w) => w.name === "Test Workspace"
      );
      expect(createdWorkspace).toBeDefined();
      expect(createdWorkspace?.type).toBe("personal");
      expect(createdWorkspace?.description).toBe("E2E test workspace");
      expectValidUUID(createdWorkspace!.id);
    });

    it("should handle multiple workspace creations", async () => {
      const { users } = testEnv;
      const userA = users.userA;

      // Create 3 workspaces
      const workspaceNames = ["Workspace 1", "Workspace 2", "Workspace 3"];

      for (const name of workspaceNames) {
        const response = await userA.trpc.workspaces.create.mutate({
          name,
          type: "team",
        });
        expectRequested(response);
      }

      // Wait for all validations
      await waitForEvent("workspaces.create.validated", {
        timeout: 15000,
      });

      // Verify all exist
      const workspaces = await userA.trpc.workspaces.list.query();
      for (const name of workspaceNames) {
        expect(workspaces).toContainEqual(
          expect.objectContaining({ name })
        );
      }
    });
  });

  describe("List Workspaces (Sync Query)", () => {
    it("should list workspaces immediately", async () => {
      const { users } = testEnv;
      const userA = users.userA;

      // Direct query - no events
      const workspaces = await userA.trpc.workspaces.list.query();

      expect(workspaces).toBeDefined();
      expect(workspaces).toBeInstanceOf(Array);
      expect(workspaces.length).toBeGreaterThan(0);
    });

    it("should only show user's own workspaces", async () => {
      const { users } = testEnv;
      const userA = users.userA;
      const userB = users.userB;

      // User A creates workspace
      await userA.trpc.workspaces.create.mutate({
        name: "User A Private Workspace",
        type: "personal",
      });
      await waitForValidation("workspaces.create");

      // User B should NOT see User A's workspace
      const userBWorkspaces = await userB.trpc.workspaces.list.query();
      expect(userBWorkspaces.workspaces).not.toContainEqual(
        expect.objectContaining({ name: "User A Private Workspace" })
      );
    });
  });

  describe("Get Workspace by ID (Sync Query)", () => {
    it("should get workspace by ID immediately", async () => {
      const { users } = testEnv;
      const userA = users.userA;

      // Create workspace
      await userA.trpc.workspaces.create.mutate({
        name: "Get Test Workspace",
        type: "personal",
      });
      await waitForValidation("workspaces.create");

      // Get workspace ID
      const workspaces = await userA.trpc.workspaces.list.query();
      const workspace = workspaces.find(
        (w) => w.name === "Get Test Workspace"
      );
      expect(workspace).toBeDefined();

      // Get by ID
      const retrieved = await userA.trpc.workspaces.get.query({
        id: workspace!.id,
      });

      expect(retrieved).toBeDefined();
      expect(retrieved.workspace.id).toBe(workspace!.id);
      expect(retrieved.workspace.name).toBe("Get Test Workspace");
    });
  });

  describe("Update Workspace (Async Validation)", () => {
    it("should update workspace via event flow", async () => {
      const { users } = testEnv;
      const userA = users.userA;

      // Create workspace
      await userA.trpc.workspaces.create.mutate({
        name: "Update Test Workspace",
        type: "personal",
      });
      await waitForValidation("workspaces.create");

      // Get workspace ID
      const workspaces = await userA.trpc.workspaces.list.query();
      const workspace = workspaces.find(
        (w) => w.name === "Update Test Workspace"
      );

      // Update workspace
      const updateResponse = await userA.trpc.workspaces.update.mutate({
        id: workspace!.id,
        name: "Updated Workspace Name",
        description: "Updated description",
      });

      expectRequested(updateResponse);

      // Wait for validation
      const validation = await waitForValidation("workspaces.update");
      expectValidated(validation);

      // Verify update
      const updated = await userA.trpc.workspaces.get.query({
        id: workspace!.id,
      });
      expect(updated.workspace.name).toBe("Updated Workspace Name");
      expect(updated.workspace.description).toBe("Updated description");
    });
  });

  describe("Delete Workspace (Owner-Only)", () => {
    it("should delete workspace when user is owner", async () => {
      const { users } = testEnv;
      const userA = users.userA;

      // Create workspace
      await userA.trpc.workspaces.create.mutate({
        name: "Delete Test Workspace",
        type: "personal",
      });
      await waitForValidation("workspaces.create");

      // Get workspace ID
      const workspaces = await userA.trpc.workspaces.list.query();
      const workspace = workspaces.find(
        (w) => w.name === "Delete Test Workspace"
      );

      // Delete workspace
      const deleteResponse = await userA.trpc.workspaces.delete.mutate({
        id: workspace!.id,
      });

      expectRequested(deleteResponse);

      // Wait for validation (should be validated for owner)
      const validation = await waitForValidation("workspaces.delete");
      expectValidated(validation);

      // Verify workspace is gone
      const remainingWorkspaces = await userA.trpc.workspaces.list.query();
      expect(remainingWorkspaces.workspaces).not.toContainEqual(
        expect.objectContaining({ id: workspace!.id })
      );
    });
  });
});
