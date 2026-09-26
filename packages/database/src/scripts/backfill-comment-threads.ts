/**
 * Backfill — legacy per-comment THREAD channels → the object's ONE room.
 * The logic and its invariants: `src/backfills/comment-threads-to-object-rooms.ts`.
 *
 * DRY RUN by default: prints the plan (one line per legacy thread) and writes
 * nothing. `--apply` moves them. Run against the pod your DATABASE_URL names:
 *   pnpm --filter @synap/database backfill:comment-threads           # dry run
 *   pnpm --filter @synap/database backfill:comment-threads --apply   # writes
 */
import { db, closeDatabase } from "../client-pg.js";
import { backfillCommentThreads } from "../backfills/comment-threads-to-object-rooms.js";

const apply = process.argv.includes("--apply");

async function main() {
  const summary = await backfillCommentThreads(db as never, { dryRun: !apply });
  for (const p of summary.plans) {
    console.log(
      `${p.outcome.padEnd(8)} ${p.object.type}:${p.object.id} thread=${p.legacyChannelId} root=${p.rootMessageId ?? "-"} replies=${p.replyCount} room=${p.roomChannelId ?? (p.outcome === "orphaned" ? "-" : "(new)")} anchor=${JSON.stringify(p.anchor)}`
    );
  }
  console.log(
    `${summary.dryRun ? "DRY RUN — nothing written. " : ""}threads=${summary.threads} moved=${summary.moved} orphaned=${summary.orphaned} empty=${summary.empty} messagesMoved=${summary.messagesMoved}`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void closeDatabase());
