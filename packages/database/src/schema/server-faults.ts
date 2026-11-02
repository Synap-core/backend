/**
 * Server Faults Schema (0392)
 *
 * The exact cause of each 5xx, keyed by the `errorId` the client was given.
 * Written by the API's error doors (`services/server-faults/record.ts` in
 * @synap/api), read only by pod admins (Hub `GET /api/hub/errors/:errorId`,
 * pod admin "Server errors"). Kept 30 days.
 *
 * TELEMETRY, like `api_usage_buckets`: never through governance, no FK to
 * users. Never holds a request body or a secret value (a Drizzle query's
 * bound `params:` line is cut out before the write).
 */

import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/** One error in a fault's `cause` chain, outermost first. */
export interface ServerFaultCause {
  name: string;
  message: string;
  stack?: string | null;
}

export const serverFaults = pgTable(
  "server_faults",
  {
    /** The errorId the client got in its 5xx body. */
    errorId: text("error_id").primaryKey(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Which door answered: `rest` (Hono) or `trpc`. */
    door: text("door").notNull(),
    method: text("method"),
    /** Redacted (`redactSecretPath`): a capability in the path never lands here. */
    path: text("path"),
    status: integer("status").notNull(),
    userId: text("user_id"),
    agentUserId: text("agent_user_id"),
    errorName: text("error_name").notNull(),
    message: text("message").notNull(),
    stack: text("stack"),
    causes: jsonb("causes").$type<ServerFaultCause[]>().notNull().default([]),
  },
  (table) => ({
    occurredAtIdx: index("idx_server_faults_occurred_at").on(table.occurredAt),
  })
);

export type ServerFault = typeof serverFaults.$inferSelect;
export type NewServerFault = typeof serverFaults.$inferInsert;
