/**
 * Inbound webhook DELIVERIES (0372, pipeline-health plan 12d8dab9 W1).
 *
 * One row per authenticated delivery to the generic inbound door
 * (`POST /api/webhooks/inbound/:subscriptionId`), written BEFORE the door
 * answers 200. The automation event is fanned out FROM the row
 * (`dispatchInboundDelivery`, @synap/events); a fan-out that does not reach
 * the queue leaves the row owed with a backoff and the sweeper delivers it.
 * `(subscriptionId, deliveryId)` is unique, so a sender's redelivery is
 * recorded once. `dispatchedAt` set = the door owes nothing more (the event
 * reached the queue, or nothing could fire and `lastError` says why).
 */
import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { webhookSubscriptions } from "./webhook_subscriptions.js";

export const inboundDeliveries = pgTable(
  "inbound_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: "cascade" }),
    /** The subscription's owner: the event's actor, and the read floor. */
    userId: text("user_id").notNull(),
    /** The subscription's space when it was received (NULL = none: nothing can fire). */
    workspaceId: uuid("workspace_id"),
    /** The sender's id for this delivery (`X-GitHub-Delivery`, `X-Synap-Delivery-Id`). */
    deliveryId: text("delivery_id"),
    /** The sender's header-borne event type (`X-GitHub-Event`). */
    event: text("event"),
    /** The body: parsed JSON, or the raw text when it is not JSON. */
    payload: jsonb("payload").notNull(),
    /** Reactors already delivered, so a retry never re-sends one. */
    delivered: text("delivered").array().notNull().default([]),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** A dispatcher's lease, then the retry backoff. NULL = due now. */
    claimedUntil: timestamp("claimed_until", {
      mode: "date",
      withTimezone: true,
    }),
    dispatchedAt: timestamp("dispatched_at", {
      mode: "date",
      withTimezone: true,
    }),
    receivedAt: timestamp("received_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    deliveryUq: uniqueIndex("inbound_deliveries_delivery_uq")
      .on(table.subscriptionId, table.deliveryId)
      .where(sql`${table.deliveryId} IS NOT NULL`),
    pendingIdx: index("inbound_deliveries_pending_idx")
      .on(table.receivedAt)
      .where(sql`${table.dispatchedAt} IS NULL`),
    userIdx: index("inbound_deliveries_user_idx").on(
      table.userId,
      table.receivedAt.desc()
    ),
  })
);

export type InboundDeliveryRow = typeof inboundDeliveries.$inferSelect;

/**
 * Observation KEYS (0372): one row per observed fact, so the same fact posted
 * by two producers (or twice by one) is recorded once. `events` is a
 * hypertable and cannot carry this unique index itself. `eventId` NULL = a
 * claim whose event write is in flight.
 */
export const observationKeys = pgTable("observation_keys", {
  key: text("key").primaryKey(),
  eventId: uuid("event_id"),
  claimedAt: timestamp("claimed_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});
