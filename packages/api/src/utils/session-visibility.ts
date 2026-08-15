/**
 * Canonical session READ/WRITE visibility.
 *
 * A `sessions` row carries NO owner and NO workspace of its own — the schema
 * (`packages/database/src/schema/sessions.ts`) gives it exactly one scoping
 * column: `channel_id`. So a session's visibility is DERIVED, not independent:
 * a caller may see (and mutate) a session exactly when they may see its
 * channel. There is no second rule to invent here, and deliberately no second
 * predicate — this delegates to `channelVisibilityWhere`, the one door for
 * channel scoping, so the two can never drift.
 *
 * Convention preserved from `hub-protocol/context.ts`: callers combine this
 * with `eq(sessions.id, …)` and return NOT_FOUND when the row does not come
 * back, so "exists but invisible to you" is indistinguishable from "does not
 * exist" — no existence oracle.
 */
import { channels, sessions } from "@synap/database/schema";
import { db, eq, and, exists, drizzleSql } from "@synap/database";
import { channelVisibilityWhere } from "./channel-visibility.js";

/**
 * Predicate for a `sessions` query: the session's channel is visible to
 * `userId`. Correlates on `sessions.channel_id`, so it must be used in a
 * statement whose FROM/UPDATE target is `sessions`.
 */
export function sessionVisibilityWhere(userId: string) {
  return exists(
    db
      .select({ one: drizzleSql`1` })
      .from(channels)
      .where(
        and(eq(channels.id, sessions.channelId), channelVisibilityWhere(userId))
      )
  );
}
