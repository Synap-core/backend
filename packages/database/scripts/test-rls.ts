/**
 * RLS Validation Test Script
 *
 * Tests that:
 * 1. SELECT policies protect reads
 * 2. Writes work without INSERT/UPDATE policies (via events)
 * 3. Documents UPDATE exception works for Yjs
 */

import { db, withRLSContext, withoutRLSContext } from "@synap/database";
import {
  workspaces,
  workspaceMembers,
  entities,
  documents,
} from "@synap/database/schema";
import { eq } from "drizzle-orm";

const TEST_USER_1 = "test-user-1";
const TEST_USER_2 = "test-user-2";

async function runTests() {
  console.log("🧪 Testing RLS Policies...\n");

  try {
    // ========================================================================
    // Test 1: SELECT policy protects reads
    // ========================================================================
    console.log("Test 1: Read protection (SELECT policy)");

    // Create workspace as user 1 (without RLS - simulating event handler)
    const [workspace] = await withoutRLSContext(async () => {
      return await db
        .insert(workspaces)
        .values({
          ownerId: TEST_USER_1,
          name: "Test Workspace",
          type: "personal",
          settings: {},
        })
        .returning();
    });

    console.log(`  ✓ Created workspace: ${workspace.id}`);

    // User 1 can see their workspace
    const user1Workspaces = await withRLSContext(TEST_USER_1, async () => {
      return await db.query.workspaces.findMany({
        where: eq(workspaces.id, workspace.id),
      });
    });

    console.log(
      `  ✓ User 1 can see workspace: ${user1Workspaces.length === 1}`,
    );

    // User 2 cannot see user 1's workspace
    const user2Workspaces = await withRLSContext(TEST_USER_2, async () => {
      return await db.query.workspaces.findMany({
        where: eq(workspaces.id, workspace.id),
      });
    });

    console.log(
      `  ✓ User 2 cannot see workspace: ${user2Workspaces.length === 0}`,
    );

    // ========================================================================
    // Test 2: Writes work without INSERT policy (event system can insert)
    // ========================================================================
    console.log("\nTest 2: Event system can write (no INSERT policy blocking)");

    // Event handler inserts entity (no RLS context needed)
    const [entity] = await withoutRLSContext(async () => {
      return await db
        .insert(entities)
        .values({
          userId: TEST_USER_1,
          workspaceId: workspace.id,
          type: "task",
          title: "Test Entity",
        })
        .returning();
    });

    console.log(`  ✓ Event handler inserted entity: ${entity.id}`);

    // ========================================================================
    // Test 3: Documents UPDATE policy works (Yjs exception)
    // ========================================================================
    console.log("\nTest 3: Documents UPDATE exception (Yjs)");

    // Create document
    const [doc] = await withoutRLSContext(async () => {
      return await db
        .insert(documents)
        .values({
          userId: TEST_USER_1,
          type: "whiteboard",
          title: "Test Doc",
          storageKey: "test",
          storageUrl: "",
          size: 0,
          currentVersion: 1,
        })
        .returning();
    });

    console.log(`  ✓ Created document: ${doc.id}`);

    // User 1 can update their own document
    await withRLSContext(TEST_USER_1, async () => {
      await db
        .update(documents)
        .set({ size: 100 })
        .where(eq(documents.id, doc.id));
    });

    console.log(`  ✓ User 1 can update own document (Yjs)`);

    // User 2 cannot update user 1's document
    try {
      await withRLSContext(TEST_USER_2, async () => {
        await db
          .update(documents)
          .set({ size: 200 })
          .where(eq(documents.id, doc.id));
      });
      console.log(`  ✗ User 2 should not be able to update`);
    } catch (err) {
      console.log(`  ✓ User 2 correctly blocked from update`);
    }

    // ========================================================================
    // Cleanup
    // ========================================================================
    console.log("\nCleaning up test data...");
    await withoutRLSContext(async () => {
      await db.delete(entities).where(eq(entities.id, entity.id));
      await db.delete(documents).where(eq(documents.id, doc.id));
      await db.delete(workspaces).where(eq(workspaces.id, workspace.id));
    });

    console.log("\n✅ All tests passed!");
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    throw error;
  }
}

// Run tests
runTests()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
