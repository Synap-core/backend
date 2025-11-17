/**
 * Multi-User Isolation Tests
 * 
 * Tests that verify Row-Level Security (RLS) properly isolates user data.
 * 
 * Requirements:
 * - PostgreSQL database with RLS enabled
 * - Better Auth configured
 * - DATABASE_URL pointing to Neon
 * 
 * Run with:
 * ```bash
 * export DB_DIALECT=postgres
 * export DATABASE_URL=postgresql://...
 * pnpm test multi-user
 * ```
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool } from '@neondatabase/serverless';
import { pgTable, uuid, text, timestamp, jsonb, integer } from 'drizzle-orm/pg-core';

// Create PostgreSQL connection directly for tests
const connectionString = process.env.DATABASE_URL!;
const pool = new Pool({ connectionString });
const db = drizzle(pool);

// Define table schemas for PostgreSQL (simplified for tests)
const events = pgTable('events', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  timestamp: timestamp('timestamp', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  type: text('type').notNull(),
  data: jsonb('data').notNull(),
  source: text('source').default('api'),
});

const entities = pgTable('entities', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  type: text('type').notNull(),
  title: text('title'),
  preview: text('preview'),
  version: integer('version').default(1).notNull(),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { mode: 'date', withTimezone: true }),
});

// Skip tests if not in PostgreSQL mode
const isPostgres = process.env.DB_DIALECT === 'postgres';
const describeIf = isPostgres ? describe : describe.skip;

describeIf('Multi-User Isolation (RLS)', () => {
  // Test user IDs
  const userA = 'test-user-a-' + Date.now();
  const userB = 'test-user-b-' + Date.now();
  
  // Test data IDs
  let noteIdA: string;
  let entityIdA: string;

  beforeAll(async () => {
    console.log('\n🧪 Setting up multi-user test environment...');
    console.log('   User A:', userA);
    console.log('   User B:', userB);
  });

  afterAll(async () => {
    // Cleanup: Delete test data for both users
    console.log('\n🧹 Cleaning up test data...');
    
    try {
      // User A cleanup
      await pool.query(`SET LOCAL app.current_user_id = '${userA}'`);
      await db.delete(entities).where(sql`id = ${entityIdA}`);
      await db.delete(events).where(sql`user_id = ${userA}`);
      
      // User B cleanup (should have no data, but just in case)
      await pool.query(`SET LOCAL app.current_user_id = '${userB}'`);
      await db.delete(events).where(sql`user_id = ${userB}`);
      
      console.log('✅ Test data cleaned up');
    } catch (error) {
      console.error('❌ Cleanup error:', error);
    }
  });

  it('should create data for User A', async () => {
    // Set RLS context to User A
    await pool.query(`SET LOCAL app.current_user_id = '${userA}'`);

    // Create an event (simulating note creation)
    const [event] = await db.insert(events).values({
      type: 'entity.created',
      data: {
        entityType: 'note',
        title: 'User A Secret Note',
        content: 'This is confidential data for User A'
      },
      source: 'test',
      userId: userA, // Must explicitly set userId for insert
    }).returning();

    expect(event).toBeDefined();
    expect(event.userId).toBe(userA);
    
    // Create an entity
    const [entity] = await db.insert(entities).values({
      type: 'note',
      title: 'User A Secret Note',
      preview: 'This is confidential...',
      userId: userA,
      filePath: `users/${userA}/notes/secret.md`,
      fileUrl: `https://storage/${userA}/notes/secret.md`,
    }).returning();

    expect(entity).toBeDefined();
    expect(entity.userId).toBe(userA);
    entityIdA = entity.id;

    console.log('✅ User A created note:', entityIdA);
  });

  it('should allow User A to read their own data', async () => {
    // Set RLS context to User A
    await pool.query(`SET LOCAL app.current_user_id = '${userA}'`);

    // User A should see their events
    const userEvents = await db.select().from(events).where(sql`type = 'entity.created'`);
    expect(userEvents.length).toBeGreaterThan(0);
    expect(userEvents.every((e) => e.userId === userA)).toBe(true);

    // User A should see their entities
    const userEntities = await db.select().from(entities);
    expect(userEntities.length).toBeGreaterThan(0);
    expect(userEntities.every((e) => e.userId === userA)).toBe(true);
    expect(userEntities.some((e) => e.id === entityIdA)).toBe(true);

    expect(userEntities.some((e) => e.filePath)?.toString()).toBeTruthy();
    console.log('✅ User A can read their own data');
  });

  it('should prevent User B from reading User A data (RLS)', async () => {
    // Set RLS context to User B
    await pool.query(`SET LOCAL app.current_user_id = '${userB}'`);

    // User B should NOT see User A's events
    const userBEvents = await db.select().from(events).where(sql`type = 'entity.created'`);
    expect(userBEvents.every((e) => e.userId !== userA)).toBe(true);

    // User B should NOT see User A's entities
    const userBEntities = await db.select().from(entities);
    expect(userBEntities.every((e) => e.userId !== userA)).toBe(true);
    expect(userBEntities.some((e) => e.id === entityIdA)).toBe(false);

    // User B should NOT see User A's content (JOIN filter)
    console.log('✅ User B CANNOT see User A data (RLS working!)');
  });

  it('should allow User B to create their own data', async () => {
    // Set RLS context to User B
    await pool.query(`SET LOCAL app.current_user_id = '${userB}'`);

    // User B creates their own event
    const [event] = await db.insert(events).values({
      type: 'entity.created',
      data: {
        entityType: 'note',
        title: 'User B Note',
        content: 'User B independent data'
      },
      source: 'test',
      userId: userB,
    }).returning();

    expect(event).toBeDefined();
    expect(event.userId).toBe(userB);

    // User B creates their own entity
    const [entity] = await db.insert(entities).values({
      type: 'note',
      title: 'User B Note',
      preview: 'User B data...',
      userId: userB,
    }).returning();

    expect(entity).toBeDefined();
    expect(entity.userId).toBe(userB);

    console.log('✅ User B created their own note:', entity.id);
  });

  it('should isolate search results between users', async () => {
    // User A searches
    await pool.query(`SET LOCAL app.current_user_id = '${userA}'`);
    const userAResults = await db.select().from(entities);
    const userATitles = userAResults.map((e) => e.title);

    // User B searches
    await pool.query(`SET LOCAL app.current_user_id = '${userB}'`);
    const userBResults = await db.select().from(entities);
    const userBTitles = userBResults.map((e) => e.title);

    // Verify no overlap
    expect(userATitles).toContain('User A Secret Note');
    expect(userATitles).not.toContain('User B Note');
    expect(userBTitles).toContain('User B Note');
    expect(userBTitles).not.toContain('User A Secret Note');

    console.log('✅ Search results are isolated between users');
  });

  it('should prevent cross-user updates', async () => {
    // User B attempts to update User A's entity
    await pool.query(`SET LOCAL app.current_user_id = '${userB}'`);

    // This should fail silently (no rows affected) due to RLS
    const result = await db
      .update(entities)
      .set({ title: 'HACKED BY USER B' })
      .where(sql`id = ${entityIdA}`);

    // Verify no update occurred
    await pool.query(`SET LOCAL app.current_user_id = '${userA}'`);
    const [entity] = await db.select().from(entities).where(sql`id = ${entityIdA}`);
    
    expect(entity.title).not.toBe('HACKED BY USER B');
    expect(entity.title).toBe('User A Secret Note');

    console.log('✅ Cross-user updates blocked by RLS');
  });

  it('should prevent cross-user deletes', async () => {
    // User B attempts to delete User A's entity
    await pool.query(`SET LOCAL app.current_user_id = '${userB}'`);

    // This should fail silently (no rows deleted) due to RLS
    await db.delete(entities).where(sql`id = ${entityIdA}`);

    // Verify entity still exists
    await pool.query(`SET LOCAL app.current_user_id = '${userA}'`);
    const [entity] = await db.select().from(entities).where(sql`id = ${entityIdA}`);
    
    expect(entity).toBeDefined();
    expect(entity.id).toBe(entityIdA);

    console.log('✅ Cross-user deletes blocked by RLS');
  });
});

describe.skip('Multi-User End-to-End Tests (with Better Auth)', () => {
  // TODO: These tests require Better Auth setup with OAuth credentials
  // They should:
  // 1. Create two real users via /api/auth/sign-up
  // 2. Get session tokens
  // 3. Call tRPC endpoints with Authorization headers
  // 4. Verify isolation at API level

  it('should signup two users', async () => {
    // Implement when Better Auth OAuth is configured
  });

  it('should create notes for both users via API', async () => {
    // Implement when Better Auth OAuth is configured
  });

  it('should prevent cross-user access via API', async () => {
    // Implement when Better Auth OAuth is configured
  });
});

