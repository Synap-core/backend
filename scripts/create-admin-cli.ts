/**
 * CLI entry point for create-admin script
 *
 * Usage: ADMIN_EMAIL=user@example.com ADMIN_PASSWORD=secret node scripts/create-admin-cli.js
 */

import "dotenv/config";
import { createAdminUser } from "./create-admin.js";

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
const name = process.env.ADMIN_NAME;

if (!email || !password) {
  console.error(
    "❌ ERROR: ADMIN_EMAIL and ADMIN_PASSWORD environment variables required"
  );
  console.error("");
  console.error("Usage:");
  console.error(
    "  ADMIN_EMAIL=user@example.com ADMIN_PASSWORD=secret node scripts/create-admin-cli.js"
  );
  process.exit(1);
}

createAdminUser(email, password, name)
  .then(({ identityId, workspaceId }) => {
    console.log("✅ Admin user created successfully");
    console.log(`   Email: ${email}`);
    console.log(`   Identity ID: ${identityId}`);
    console.log(`   Workspace ID: ${workspaceId}`);
    console.log("");
    console.log("You can now login with these credentials.");
    process.exit(0);
  })
  .catch((error: any) => {
    console.error("❌ Failed to create admin user:", error.message);
    if (error.response?.data) {
      console.error(
        "Kratos error:",
        JSON.stringify(error.response.data, null, 2)
      );
    }
    process.exit(1);
  });
