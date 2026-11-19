/**
 * CLI: write every app connection's approval in its v2 form
 * (`apps.approved_access`, 0434; app permissions W2; the rule:
 * `services/app-access-backfill.ts`). Run by the pod's owner, inside the
 * backend container:
 *
 *   node dist/scripts/backfill-app-access.js            DRY RUN (default): counts, nothing written
 *   node dist/scripts/backfill-app-access.js --apply    writes v2 for the rows that lift
 *
 * A row that would widen or narrow is a re-consent: never written, listed
 * with why. DATABASE_URL is already set in the container. Read the dry run
 * first.
 */

import "dotenv/config";
import { backfillAppAccess } from "../services/app-access-backfill.js";

const apply = process.argv.slice(2).includes("--apply");

backfillAppAccess({ apply }).then(
  (report) => {
    console.log(
      `App connections with an approval: ${report.apps} — ${apply ? "APPLY" : "DRY RUN (no writes)"}`
    );
    console.log(
      `Liftable (v2 says exactly what the pairs say): ${report.liftable}` +
        ` (already v2: ${report.already}; ${apply ? `written: ${report.written}; changed meanwhile, not written: ${report.changed}` : `would write: ${report.liftable - report.already}`})`
    );
    console.log(
      `Re-consent (left on their pairs): ${report.reconsent.total}` +
        ` — widens: ${report.reconsent.widens}, narrows: ${report.reconsent.narrows}, unplaceable: ${report.reconsent.unplaceable}`
    );
    for (const r of report.rows) {
      if (r.outcome !== "reconsent") continue;
      console.log(
        `  ${r.publicId} "${r.name}": ${r.reason} — ${r.example ?? ""}`
      );
    }
    process.exit(0);
  },
  (error) => {
    console.error("[backfill-app-access] failed:", error);
    process.exit(1);
  }
);
