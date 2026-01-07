/**
 * Intelligence Services Schema
 * 
 * Registry of external intelligence services that can process data
 * from the Data Pod (e.g., Synap Intelligence Service, third-party AI providers)
 */

import { pgTable, text, timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';

export const intelligenceServices = pgTable('intelligence_services', {
  id: text('id').primaryKey(),
  
  // Service identification
  serviceId: text('service_id').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  version: text('version'),
  
  // Service endpoints
  webhookUrl: text('webhook_url').notNull(),
  
  // Authentication
  apiKey: text('api_key').notNull(), // For authenticating callbacks from service
  
  // Capabilities (what this service can do)
  capabilities: jsonb('capabilities').$type<string[]>().notNull().default([]),
  
  // Pricing model
  pricing: text('pricing').default('free'), // 'free', 'premium', 'enterprise', 'custom'
  
  // Status
  status: text('status').notNull().default('active'), // 'active', 'inactive', 'suspended'
  enabled: boolean('enabled').notNull().default(true),
  
  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  
  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  lastHealthCheck: timestamp('last_health_check'),
});

export type IntelligenceService = typeof intelligenceServices.$inferSelect;
export type NewIntelligenceService = typeof intelligenceServices.$inferInsert;
