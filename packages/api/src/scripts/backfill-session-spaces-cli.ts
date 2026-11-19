/**
 * CLI: put every session with no space, filed in a project, into the
 * project's home space (W3; the rule: `services/focus-sessions/backfill-session-spaces.ts`).
 * Run by the pod's owner, inside the backend container:
 *
 *   node dist/scripts/backfill-session-spaces.js            DRY RUN (default): what would move, each refusal
 *   node dist/scripts/backfill-session-spaces.js --apply    moves them
 *
 * DATABASE_URL is already set in the container. Read the dry run first.
 */

import "dotenv/config";
import { backfillSessionSpaces } from "../services/focus-sessions/backfill-session-spaces.js";

const apply = process.argv.slice(2).includes("--apply");

backfillSessionSpaces({ apply }).then(
  (report) => {
    console.log(
      `Sessions with no space, filed in a project with a home space: ${report.candidates} — ${apply ? "APPLY" : "DRY RUN (no writes)"}`
    );
    console.log(`${apply ? "Moved" : "Would move"}: ${report.moved.length}`);
    console.log(`Write receipts left where they are: ${report.receiptsKept}`);
    console.log(`Refused: ${report.refused.length}`);
    for (const r of report.refused) {
      console.log(`  ${r.sessionId} → ${r.workspaceId}: ${r.reason}`);
    }
    console.log(
      `templateId "null" strings ${apply ? "cleared" : "to clear"}: ${report.nullTemplateIds}`
    );
    process.exit(0);
  },
  (error) => {
    console.error("[backfill-session-spaces] failed:", error);
    process.exit(1);
  }
);
