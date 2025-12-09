import { pgTable, uuid, text, boolean, timestamp, jsonb, integer } from 'drizzle-orm/pg-core';
import { events } from './events.js';

export const webhookSubscriptions = pgTable('webhook_subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  eventTypes: text('event_types').array().notNull(),
  secret: text('secret').notNull(),
  active: boolean('active').default(true).notNull(),
  retryConfig: jsonb('retry_config').default({ maxRetries: 3 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
});

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').defaultRandom().primaryKey(),
  subscriptionId: uuid('subscription_id')
    .notNull()
    .references(() => webhookSubscriptions.id, { onDelete: 'cascade' }),
  eventId: uuid('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'cascade' }),
  status: text('status').notNull(), // 'success' | 'failed' | 'pending'
  responseStatus: integer('response_status'),
  attempt: integer('attempt').default(1).notNull(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect;
export type NewWebhookSubscription = typeof webhookSubscriptions.$inferInsert;

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
