/**
 * CLI: create first admin inside the backend image (or locally with tsx + .env).
 *
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... node dist/scripts/create-admin-cli.js
 */

import "dotenv/config";
import { createAdminUser } from "./create-admin-user.js";

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
const name = process.env.ADMIN_NAME;
const createWorkspace = process.env.CREATE_WORKSPACE !== "false";

if (!email || !password) {
  console.error(
    "ERROR: ADMIN_EMAIL and ADMIN_PASSWORD environment variables required"
  );
  console.error("");
  console.error("Usage:");
  console.error(
    "  ADMIN_EMAIL=user@example.com ADMIN_PASSWORD=secret node dist/scripts/create-admin-cli.js"
  );
  process.exit(1);
}

createAdminUser(email, password, name, { createWorkspace })
  .then(({ identityId, workspaceId }) => {
    console.log("Admin user created successfully");
    console.log(`   Email: ${email}`);
    console.log(`   Identity ID: ${identityId}`);
    if (workspaceId) {
      console.log(`   Workspace ID: ${workspaceId}`);
    } else {
      console.log("   Workspace: skipped (--no-workspace)");
    }
    console.log("");
    console.log("You can now sign in with this email and password.");
    process.exit(0);
  })
  .catch((error: unknown) => {
    const e = error as { message?: string; response?: { data?: unknown } };
    console.error("Failed to create admin user:", e.message);
    if (e.response?.data) {
      console.error("Kratos error:", JSON.stringify(e.response.data, null, 2));
    }
    process.exit(1);
  });
