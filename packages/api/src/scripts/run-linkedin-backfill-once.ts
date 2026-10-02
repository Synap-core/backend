/**
 * One-shot LinkedIn conversation backfill.
 *
 * Surfaces a connected LinkedIn account's existing conversations as Synap
 * EXTERNAL channels via `runLinkedInBackfill` (idempotent — safe to re-run).
 *
 * Resolves the acting owner from `workspaces.ownerId` for WORKSPACE_ID so the
 * capability runs as the pod owner (owner-bypasses the capability gate).
 *
 * Usage (from packages/api, DATABASE_URL in ../../.env):
 *   pnpm exec tsx src/scripts/run-linkedin-backfill-once.ts
 *   # overridable via env:
 *   ACCOUNT_ID=acc_... WORKSPACE_ID=<uuid> pnpm exec tsx src/scripts/run-linkedin-backfill-once.ts
 */

import "dotenv/config";
import { db, eq, workspaces } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { runLinkedInBackfill } from "../services/connectors/run-linkedin-backfill.js";

const logger = createLogger({ module: "run-linkedin-backfill-once" });

const ACCOUNT_ID = process.env.ACCOUNT_ID ?? "acc_01kyd9cp52fvg95k7jrb43zhga";
const WORKSPACE_ID =
  process.env.WORKSPACE_ID ?? "499328b7-fd35-4143-b1bc-67b9e45d9b4b";

async function main(): Promise<void> {
  logger.info(
    { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID },
    "Resolving workspace owner…"
  );

  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, WORKSPACE_ID),
    columns: { id: true, ownerId: true },
  });
  if (!ws) {
    throw new Error(
      `Workspace ${WORKSPACE_ID} not found — cannot resolve the owner to run as.`
    );
  }

  logger.info(
    { accountId: ACCOUNT_ID, workspaceId: ws.id, ownerId: ws.ownerId },
    "Starting LinkedIn backfill…"
  );

  const result = await runLinkedInBackfill({
    accountId: ACCOUNT_ID,
    userId: ws.ownerId,
    workspaceId: ws.id,
  });

  logger.info(result, "LinkedIn backfill finished");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "LinkedIn backfill failed");
    // eslint-disable-next-line no-console
    console.error("❌ LinkedIn backfill failed:", err?.message ?? err);
    process.exit(1);
  });
