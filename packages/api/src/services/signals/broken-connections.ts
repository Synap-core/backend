/**
 * BROKEN CONNECTIONS — the person's own tools that need a sign-in again, read
 * for the needs-you union (`signals.ts` › `readAttention`) as `access-request`
 * rows (UI plan 2026-10-31 appendix ba328893 §1.3 defect 3 and DP6: "the union
 * reads connection health").
 *
 * The pod holds connection health itself: a capability connection is a
 * `secrets` row with `capability_id` set, and `connection_state` mirrors the
 * broker's credential health (migration 0229). Dispatch flips it to
 * `needs_reauth` after repeated auth failures, the live reconciler marks it from
 * the broker's own error state, and the next call that succeeds clears it
 * (`external-dispatch.ts`). So the ask lives exactly as long as the connection
 * is broken, never as long as a bell row stays unread.
 *
 * One row per TOOL, not per connection, and only when NONE of the person's live
 * connections of that tool still works: a tool with one dead account and one
 * healthy one keeps running (the reconciler moves the default onto the healthy
 * one, `chooseHealthyDefault`), so it asks nothing. The same rule as the
 * phone's Reconnect card (`onlySignedOut`, `@synap-core/headless/connectors`).
 * A `disconnected` row was removed on purpose: it is no connection at all.
 *
 * Read for the person who owns the connections, admin or not; under any lens
 * it is not read (`readsAccess`): a connection lives in no space or project.
 */

import {
  and,
  asc,
  db,
  drizzleSql,
  eq,
  isNotNull,
  isNull,
} from "@synap/database";
import { capabilities, secrets } from "@synap/database/schema";
import type { BrokenConnectionSignalInput } from "./needs-you-union.js";
import {
  ACCESS_REQUEST_SCAN_LIMIT,
  type AccessRequestHalf,
} from "./access-requests.js";

/** A connection's health, NULL read as healthy (no failure ever recorded, 0229). */
const state = drizzleSql`coalesce(${secrets.connectionState}, 'connected')`;

/** The person's tools whose every live connection needs a sign-in, oldest break first. */
export async function listBrokenConnections(args: {
  userId: string;
}): Promise<AccessRequestHalf<BrokenConnectionSignalInput>> {
  const brokenAt = drizzleSql<
    Date | string
  >`coalesce(max(${secrets.lastAuthErrorAt}), max(${secrets.updatedAt}))`;
  const rows = await db
    .select({
      capabilityId: drizzleSql<string>`${secrets.capabilityId}`,
      toolName: drizzleSql<string | null>`max(${capabilities.name})`,
      connectionName: drizzleSql<string | null>`max(${secrets.name})`,
      brokenAt,
    })
    .from(secrets)
    .leftJoin(capabilities, eq(capabilities.id, secrets.capabilityId))
    .where(
      and(
        eq(secrets.userId, args.userId),
        isNotNull(secrets.capabilityId),
        isNull(secrets.deletedAt),
        drizzleSql`${state} <> 'disconnected'`
      )
    )
    .groupBy(secrets.capabilityId)
    .having(drizzleSql`bool_and(${state} = 'needs_reauth')`)
    .orderBy(asc(brokenAt))
    .limit(ACCESS_REQUEST_SCAN_LIMIT + 1);
  const mapped = rows.map((r): BrokenConnectionSignalInput => ({
    capabilityId: r.capabilityId,
    name: r.toolName?.trim() || r.connectionName?.trim() || "",
    brokenAt: new Date(r.brokenAt),
  }));
  return {
    rows: mapped.slice(0, ACCESS_REQUEST_SCAN_LIMIT),
    truncated: mapped.length > ACCESS_REQUEST_SCAN_LIMIT,
  };
}
