/**
 * One door for "which `<toolName>` tool row does this run belong to?" —
 * shared by every caller that used to hand-roll an unscoped
 * `findFirst({ where: eq(tools.name, …) })`.
 *
 * This pod had TWO `discord` tool rows (one per workspace). The original
 * callers used an unscoped, unordered `findFirst` — no workspace filter, no
 * ORDER BY — so Postgres could return either row. The operator toggled a
 * feature ON via one workspace's row; the reader picked the OTHER
 * workspace's row and reported it off. Same command, two different rows,
 * contradictory answers.
 *
 * Rules:
 *  - Caller has a workspace (a per-request handler that knows who invoked
 *    it) → resolve WITHIN that workspace only. Never silently fall back to
 *    another workspace's config; that is what produced the mismatch.
 *  - No caller workspace (a cron tick) → deterministic: prefer a row for
 *    which the CALLER'S OWN `isEnabled` predicate returns true, else the
 *    oldest by `createdAt`. Never arbitrary heap order.
 *
 * The `isEnabled` predicate is supplied by the caller, not baked in here —
 * an earlier version of this door hard-coded a `discord.eventSync.enabled`
 * check that a DIFFERENT caller (the mail-feed cron) also used as its
 * tie-break while itself gating on `discord.mailFeed.enabled`. On the exact
 * two-workspace pod this door exists to fix, that mismatch reproduced the
 * ORIGINAL incident inside the fix for it: the resolver preferred the
 * eventSync-enabled row, mail-feed read that row's (disabled) mailFeed flag,
 * and reported "disabled" while the operator was looking at mail feed
 * switched on. The predicate MUST match the feature asking the question —
 * passing it in per-call is what makes that impossible to get wrong again.
 *
 * NOTE: a scoped cron path still services a single workspace per tick.
 * Running every enabled workspace is a deliberate follow-up, not something
 * to widen silently here — it changes how many events get posted.
 *
 * This is deliberately NOT the same door as `resolveToolByWebhookToken` —
 * selecting by matching a presented secret is a different question from
 * selecting by scope/enabled-state, and merging them would produce a
 * function with mutually-exclusive modes. Two doors, one per genuinely
 * different selection strategy — do not add a third.
 */
import { asc, eq } from "drizzle-orm";
import { db } from "@synap/database";
import { tools } from "@synap/database/schema";

export interface ResolvedTool {
  id: string;
  createdBy: string;
  workspaceId: string | null;
  metadata: unknown;
}

/**
 * @param toolName the `tools.name` row to look up, e.g. "discord" | "cal_com".
 * @param isEnabled the CALLER's own "is this the row I care about" predicate,
 *                   evaluated against a candidate row's `metadata` — only
 *                   consulted for the unscoped (no workspaceId) tie-break.
 * @param workspaceId caller's workspace, or null/undefined for an unscoped
 *                     (cron) run. When provided, only that workspace's row is
 *                     ever returned (`isEnabled` is not consulted).
 */
export async function resolveTool(
  toolName: string,
  isEnabled: (metadata: unknown) => boolean,
  workspaceId?: string | null
): Promise<ResolvedTool | null> {
  const rows = await db.query.tools.findMany({
    where: eq(tools.name, toolName),
    columns: { id: true, createdBy: true, workspaceId: true, metadata: true },
    orderBy: [asc(tools.createdAt)],
  });

  if (rows.length === 0) return null;

  if (workspaceId) {
    return rows.find((r) => r.workspaceId === workspaceId) ?? null;
  }

  return rows.find((r) => isEnabled(r.metadata)) ?? rows[0]!;
}
