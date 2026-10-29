/**
 * API Usage Buckets Schema (0364)
 *
 * How many calls each key, client and conversation makes, per 5-minute
 * bucket, by limiter class and outcome. Written by the API's usage middleware
 * (`apps/api/src/middleware/usage-telemetry.ts`): counted in memory, flushed
 * once a minute in ONE batched upsert (`flushApiUsage`). Kept 30 days by the
 * daily `api-usage-retention` job. Read only by pod admins
 * (`synap_diagnose` type `usage`, Hub `GET /api/hub/usage`).
 *
 * TELEMETRY, like `api_keys.last_used_at`: never through governance, no FK to
 * the key (a revoked key keeps its history), no user column.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  unique,
  index,
} from "drizzle-orm/pg-core";

export const apiUsageBuckets = pgTable(
  "api_usage_buckets",
  {
    /** Start of the 5-minute bucket (UTC, aligned on 5 minutes). */
    bucketStart: timestamp("bucket_start", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    /** The key the request authenticated with; NULL before auth (a 429) or for a person's cookie. */
    apiKeyId: uuid("api_key_id"),
    /**
     * The rate limiter's bucket identity, hashed: `key:<h>`, `session:<h>`,
     * `ip:<h>`, `token:<h>`. Joins a 429 answered before auth to its key.
     */
    limiterKey: text("limiter_key").notNull(),
    /** `X-Synap-Client` (`synap-bridge/0.6.0`), else the conversation's harness, else `unknown`. */
    client: text("client").notNull(),
    /** The calling conversation (`claude-code:<uuid>`), when the client named one. */
    conversationId: text("conversation_id"),
    /** The limiter class the request spent (`crud`, `import`, `public_read`, ...). */
    rlClass: text("rl_class").notNull(),
    /** `2xx` | `3xx` | `4xx` | `429` | `5xx`. */
    outcome: text("outcome").notNull(),
    calls: integer("calls").notNull().default(0),
    /** Summed wall time of those calls, ms (a held long-poll shows here). */
    heldMs: bigint("held_ms", { mode: "number" }).notNull().default(0),
  },
  (table) => ({
    dims: unique("api_usage_buckets_dims_unique")
      .on(
        table.bucketStart,
        table.apiKeyId,
        table.limiterKey,
        table.client,
        table.conversationId,
        table.rlClass,
        table.outcome
      )
      .nullsNotDistinct(),
    keyTimeIdx: index("idx_api_usage_buckets_key_time").on(
      table.apiKeyId,
      table.bucketStart
    ),
    timeIdx: index("idx_api_usage_buckets_time").on(table.bucketStart),
  })
);

export type ApiUsageBucket = typeof apiUsageBuckets.$inferSelect;
