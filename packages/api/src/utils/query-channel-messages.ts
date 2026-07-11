/**
 * queryChannelMessages — THE ONE DOOR for channel message-HISTORY reads.
 *
 * Every path that loads a list of a channel's messages as conversation history
 * MUST go through this helper. It structurally owns the read filter triad so a
 * future read path physically cannot forget one of them:
 *
 *   1. VISIBILITY  — when a `userId` is given, the channel is verified against
 *                    the canonical `channelVisibilityWhere` predicate and a
 *                    `NOT_FOUND` is thrown if the caller can't see it. Callers
 *                    that authorize the channel by ANOTHER gate (the access
 *                    layer's `getReadScope`, or a bespoke workspace-membership
 *                    check) simply OMIT `userId` — they must have already
 *                    authorized `channelId` themselves.
 *   2. deletedAt   — `isNull(messages.deletedAt)`: soft-deleted messages never
 *                    surface on (re)load.
 *   3. ephemeral   — `eq(messages.ephemeral, false)`: ephemeral recaps
 *                    ("catch me up" summaries) are live-only and must never be
 *                    restored into a fresh client's / agent's history.
 *
 * This closes the ephemeral-leak class permanently: you cannot fetch history
 * without (2) and (3), because there is no other supported door.
 *
 * NOT for this door (leave them as direct reads — they are not history reads):
 *   - single-row write-support lookups (`findFirst` by message id),
 *   - aggregates / counters (unread badges, "has-assistant" flags, rate limits),
 *   - Typesense `searchMessages` (already gated by `channelVisibilityWhere` as a
 *     DB pre-check before hitting the index).
 *
 * This is a PURE EXTRACTION of filters that were already applied verbatim at the
 * migrated call sites — it changes no query's columns, ordering, filters, or
 * pagination. Paths whose current shape lacks part of the triad are deliberately
 * NOT migrated (migrating them would change behavior); they are tracked
 * separately as divergences to reconcile.
 */

import type { SQL } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  db,
  messages,
  channels,
  and,
  eq,
  isNull,
  lt,
  asc,
  desc,
} from "@synap/database";
import { channelVisibilityWhere } from "./channel-visibility.js";

/** The full message row exactly as `db.query.messages.findMany()` returns it. */
type FullMessageRow = Awaited<
  ReturnType<typeof db.query.messages.findMany>
>[number];

export interface QueryChannelMessagesOptions {
  /** Channel whose history to read. */
  channelId: string;
  /**
   * When set, the channel is gated by `channelVisibilityWhere(userId)` and a
   * `TRPCError NOT_FOUND` is thrown if the caller can't see it. OMIT this when
   * the caller has ALREADY authorized `channelId` via another gate (access
   * layer / bespoke membership check) — the door then trusts that gate.
   */
  userId?: string;
  /** `asc` / `desc` on `messages.timestamp`. */
  order: "asc" | "desc";
  /** Row cap. Omit for no limit. */
  limit?: number;
  /** Keyset cursor: only rows with `messages.id < cursor`. */
  cursor?: string;
  /**
   * Relational-API column projection (e.g. `{ role: true, content: true }`).
   * Omit for the full row.
   */
  columns?: Record<string, boolean>;
  /**
   * An extra AND-ed predicate for callers with an additional row filter that is
   * NOT part of the triad (e.g. `metadata->>'pinned' = 'true'`). The triad is
   * always applied regardless.
   */
  extraWhere?: SQL;
}

/**
 * Read a channel's message history through the single gated door.
 *
 * @typeParam T - row shape; defaults to the full message row. Callers that pass
 *   `columns` should supply the matching subset type.
 */
export async function queryChannelMessages<T = FullMessageRow>(
  database: typeof db,
  opts: QueryChannelMessagesOptions
): Promise<T[]> {
  const { channelId, userId, order, limit, cursor, columns, extraWhere } = opts;

  // (1) VISIBILITY — only when the caller delegates the gate to the door.
  if (userId !== undefined) {
    const channel = await database.query.channels.findFirst({
      where: and(eq(channels.id, channelId), channelVisibilityWhere(userId)),
    });
    if (!channel) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Channel not found or access denied",
      });
    }
  }

  // (2) deletedAt + (3) ephemeral are ALWAYS applied — this is the whole point.
  const where = and(
    eq(messages.channelId, channelId),
    isNull(messages.deletedAt),
    eq(messages.ephemeral, false),
    cursor ? lt(messages.id, cursor) : undefined,
    extraWhere
  );

  const rows = await database.query.messages.findMany({
    where,
    orderBy:
      order === "asc" ? [asc(messages.timestamp)] : [desc(messages.timestamp)],
    ...(limit !== undefined ? { limit } : {}),
    ...(columns ? { columns } : {}),
  });
  // Column projection is caller-parameterized (`columns`), so the concrete row
  // shape is only known to the caller via the `T` type argument.
  return rows as unknown as T[];
}
