/**
 * The light read's AI budget — how many Library items a person may have read
 * WITH AI (file extract, photo OCR, transcript, AI summary) in a rolling 24h.
 *
 * Reading a public page or typed text costs nothing and never touches this.
 * Everything that calls the IS reserves one unit per item first.
 *
 * The count lives on the items themselves: a reservation stamps
 * `documents.metadata.importRead.aiAt` on the item it is spent for, and the
 * budget is the number of the person's items stamped in the last 24h. No new
 * table, and an item that dies mid-read still counts what it spent.
 *
 * ATOMIC, like `ai-dispatch-budget.ts`: a transaction-scoped advisory lock
 * keyed by the person, the count re-read inside it, then the stamp — so two
 * reads running at once can never both take the last unit. Interval
 * arithmetic stays in SQL (postgres.js on the pod image crashes on a bound
 * Date).
 *
 * Over budget is NOT a drop: the caller marks the item `over_budget` and the
 * hourly sweep reads it once the window has room again.
 */

import { documents, drizzleSql, and, eq } from "@synap/database";
import type { db as DbType } from "@synap/database";

/** Items read with AI per person per rolling 24h (env `SYNAP_LIBRARY_READ_AI_PER_DAY`). */
export const LIBRARY_READ_AI_PER_DAY_DEFAULT = 200;

export function libraryReadAiPerDay(): number {
  const raw = Number(process.env.SYNAP_LIBRARY_READ_AI_PER_DAY);
  return Number.isInteger(raw) && raw >= 0
    ? raw
    : LIBRARY_READ_AI_PER_DAY_DEFAULT;
}

export type LibraryReadDb = Pick<
  typeof DbType,
  "select" | "update" | "transaction" | "execute"
>;

/** Items this person had read with AI in the last 24h. */
export async function libraryReadAiUsedToday(
  database: Pick<typeof DbType, "select">,
  userId: string
): Promise<number> {
  const [row] = await database
    .select({ n: drizzleSql<number>`count(*)::int` })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        drizzleSql`${documents.deletedAt} IS NULL`,
        drizzleSql`${documents.metadata} ? 'importItem'`,
        drizzleSql`(${documents.metadata} #>> '{importRead,aiAt}')::timestamptz >= now() - interval '24 hours'`
      )
    );
  return Number(row?.n ?? 0);
}

/**
 * Take one unit for `itemId`. True ⇒ the item is stamped and may call the IS.
 * An item already stamped inside the window reuses its unit (a retried job
 * never pays twice).
 */
export async function reserveLibraryReadAi(
  database: LibraryReadDb,
  args: { userId: string; itemId: string; perDay?: number }
): Promise<boolean> {
  const perDay = args.perDay ?? libraryReadAiPerDay();
  return database.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`select pg_advisory_xact_lock(hashtext(${`library-light-read|${args.userId}`}))`
    );
    const [own] = await tx
      .select({
        fresh: drizzleSql<boolean>`coalesce((${documents.metadata} #>> '{importRead,aiAt}')::timestamptz >= now() - interval '24 hours', false)`,
      })
      .from(documents)
      .where(
        and(eq(documents.id, args.itemId), eq(documents.userId, args.userId))
      )
      .limit(1);
    if (!own) return false;
    if (own.fresh) return true;
    const used = await libraryReadAiUsedToday(tx, args.userId);
    if (used >= perDay) return false;
    await tx
      .update(documents)
      .set({
        metadata: drizzleSql`jsonb_set(coalesce(${documents.metadata}, '{}'::jsonb), '{importRead}', coalesce(${documents.metadata} -> 'importRead', '{"status":"not_read","suggestedActions":[]}'::jsonb) || jsonb_build_object('aiAt', to_jsonb(now())))`,
      })
      .where(eq(documents.id, args.itemId));
    return true;
  });
}
