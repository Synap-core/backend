/**
 * Recompute "when we last spoke" — backfill and repair (CRM recall C-W2, 0359).
 *
 * Rebuilds `entities.last_interaction_at` and its `properties.lastInteractionAt`
 * projection EXACTLY from the graph, with the same rule the reactor and the
 * daily sweep apply (`interaction-evidence.ts`). The only writer allowed to
 * lower the value: run it after deleting an event or removing a wrong attendee.
 *
 * SAFETY: dry run by default; nothing is written without `--apply`.
 *
 * Usage (against the pod your DATABASE_URL points at):
 *   pnpm --filter @synap/database recompute-last-interaction            # dry run
 *   pnpm --filter @synap/database recompute-last-interaction -- --apply
 */
import { db, sql } from "../client-pg.js";
import { rebuildLastInteraction } from "../services/interactions/interaction-evidence.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  const apply = process.argv.includes("--apply");
  rebuildLastInteraction(db, { apply })
    .then(async (r) => {
      console.log(
        `${apply ? "Applied" : "Dry run"}: ${r.set} to set (${r.lowered} lowered), ${r.cleared} to clear, ${r.unchanged} unchanged.` +
          (apply ? "" : " Re-run with --apply to write.")
      );
      await sql.end();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("Recompute failed:", error);
      await sql.end().catch(() => {});
      process.exit(1);
    });
}
