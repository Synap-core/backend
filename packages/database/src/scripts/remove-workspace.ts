// @ts-nocheck — run with: pnpm tsx packages/database/src/scripts/remove-workspace.ts
import postgres from "postgres";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env.development.local") });
config({ path: resolve(__dirname, "../../../../.env.local") });
config({ path: resolve(__dirname, "../../../../.env") });

const WORKSPACE_ID = "3c94f29e-3b65-4a94-9b05-4f0851c479ad";

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

async function run() {
  const [ws] = await sql`
    SELECT id, name, archived_at FROM workspaces WHERE id = ${WORKSPACE_ID}
  `;

  if (!ws) {
    console.log("Workspace not found — nothing to do.");
    await sql.end();
    return;
  }

  console.log(`Found: "${ws.name}"  archived_at=${ws.archived_at ?? "NULL"}`);

  // Hard-delete: remove members first, then the workspace row.
  // If foreign keys cascade, the workspace delete covers everything;
  // the members delete is a safe no-op in that case.
  await sql`DELETE FROM workspace_members WHERE workspace_id = ${WORKSPACE_ID}`;
  await sql`DELETE FROM workspaces WHERE id = ${WORKSPACE_ID}`;

  console.log("Deleted.");
  await sql.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
