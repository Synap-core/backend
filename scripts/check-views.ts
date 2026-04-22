/**
 * Quick script to check if views exist in database
 *
 * Usage: pnpm tsx scripts/check-views.ts [workspace-id]
 */

import { getDb } from "../packages/database/src/client-pg.js";
import {
  views,
  workspaces,
  profiles,
} from "../packages/database/src/schema/index.js";
import { eq } from "drizzle-orm";

async function checkViews() {
  const db = await getDb();
  const workspaceId = process.argv[2];

  console.log("🔍 Checking views in database...\n");

  if (workspaceId) {
    console.log(`📋 Views for workspace: ${workspaceId}\n`);

    // Get workspace info
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    });

    if (!workspace) {
      console.error(`❌ Workspace ${workspaceId} not found`);
      process.exit(1);
    }

    console.log(`✅ Workspace found: ${workspace.name || workspaceId}\n`);

    // Get all views for this workspace
    const allViews = await db.query.views.findMany({
      where: eq(views.workspaceId, workspaceId),
    });

    console.log(`📊 Total views in workspace: ${allViews.length}\n`);

    if (allViews.length === 0) {
      console.log("⚠️  No views found in this workspace");
      console.log("\n💡 Possible reasons:");
      console.log("  1. Executor hasn't run yet");
      console.log("  2. Executor failed silently");
      console.log("  3. Task profile doesn't exist");
      return;
    }

    // Group by user
    const viewsByUser = new Map<string, typeof allViews>();
    for (const view of allViews) {
      if (!viewsByUser.has(view.userId)) {
        viewsByUser.set(view.userId, []);
      }
      viewsByUser.get(view.userId)!.push(view);
    }

    console.log("👥 Views by user:\n");
    for (const [userId, userViews] of viewsByUser) {
      console.log(`  User: ${userId}`);
      console.log(`  Views: ${userViews.length}`);
      for (const view of userViews) {
        console.log(`    - ${view.name} (${view.type}) - ID: ${view.id}`);
      }
      console.log();
    }

    // Check for default views
    const defaultViewNames = ["All Tasks", "Task Board", "Main Whiteboard"];
    const _foundDefaults = allViews.filter((v) =>
      defaultViewNames.some((name) => v.name.includes(name))
    );

    console.log("🎯 Default views check:\n");
    for (const name of defaultViewNames) {
      const found = allViews.find((v) => v.name === name);
      if (found) {
        console.log(`  ✅ ${name} - ID: ${found.id}, User: ${found.userId}`);
      } else {
        console.log(`  ❌ ${name} - NOT FOUND`);
      }
    }

    // Check task profile
    console.log("\n📋 Task profile check:\n");
    const taskProfile = await db.query.profiles.findFirst({
      where: eq(profiles.slug, "task"),
    });

    if (taskProfile) {
      console.log(`  ✅ Task profile exists - ID: ${taskProfile.id}`);
    } else {
      console.log(
        `  ❌ Task profile NOT FOUND - This is why views weren't created!`
      );
      console.log(`     Run migration to seed system profiles.`);
    }
  } else {
    // List all views
    const allViews = await db.query.views.findMany({
      orderBy: (views, { desc }) => [desc(views.createdAt)],
      limit: 20,
    });

    console.log(`📊 Recent views (showing last 20):\n`);
    for (const view of allViews) {
      console.log(`  - ${view.name} (${view.type})`);
      console.log(`    Workspace: ${view.workspaceId}`);
      console.log(`    User: ${view.userId}`);
      console.log(`    Created: ${view.createdAt}`);
      console.log();
    }
  }

  await db.close();
}

checkViews().catch(console.error);
