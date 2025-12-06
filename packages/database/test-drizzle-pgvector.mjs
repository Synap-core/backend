/**
 * Test Drizzle ORM with pgvector integration
 * This isolates whether Drizzle is breaking the pgvector.toSql() values
 */

import postgres from 'postgres';
import pgvector from 'pgvector';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as drizzleSql, eq } from 'drizzle-orm';
import { entityVectors } from './src/schema/index.js';

const sql = postgres('postgresql://postgres:synap_dev_password@localhost:5432/synap');
const db = drizzle(sql);

async function testDrizzleWithPgvector() {
  console.log('\n📊 Testing Drizzle ORM + pgvector Integration');
  console.log('===============================================\n');

  try {
    // Step 1: Create test embedding
    const testEmbedding = Array(1536).fill(0).map((_, i) => i / 1536);
    console.log('✅ Created test embedding:', testEmbedding.length, 'dimensions');

    // Step 2: Test INSERT using Drizzle with plain array (no pgvector.toSql)
    console.log('\n📝 Test 1: Drizzle INSERT with plain number[]...');
    try {
      await sql`DELETE FROM entity_vectors WHERE user_id = 'test-drizzle'`;
      await sql`DELETE FROM entities WHERE user_id = 'test-drizzle'`;
      
      await sql`INSERT INTO entities (id, user_id, type, title) VALUES ('33333333-3333-3333-3333-333333333333', 'test-drizzle', 'note', 'Test')`;
      
      await db.insert(entityVectors).values({
        entityId: '33333333-3333-3333-3333-333333333333',
        userId: 'test-drizzle',
        entityType: 'note',
        embedding: testEmbedding, // Plain number[]
        embeddingModel: 'test',
        indexedAt: new Date(),
        updatedAt: new Date(),
      });
      console.log('✅ Drizzle INSERT with number[] successful');
    } catch (error) {
      console.error('❌ Drizzle INSERT with number[] failed:', error.message);
    }

    // Step 3: Test SELECT using Drizzle with plain array (no pgvector.toSql)
    console.log('\n🔍 Test 2: Drizzle SELECT with plain number[]...');
    try {
      const results = await db
        .select({
          entityId: entityVectors.entityId,
          distance: drizzleSql<number>`embedding <-> ${testEmbedding}`,
        })
        .from(entityVectors)
        .where(eq(entityVectors.userId, 'test-drizzle'))
        .limit(1);
      console.log('✅ Drizzle SELECT with number[] successful:', results[0]);
    } catch (error) {
      console.error('❌ Drizzle SELECT with number[] failed:', error.message);
      console.error('   Error code:', error.code);
    }

    // Step 4: Test SELECT using Drizzle with pgvector.toSql()
    console.log('\n🔍 Test 3: Drizzle SELECT with pgvector.toSql()...');
    try {
      const embeddingWrapped = pgvector.toSql(testEmbedding);
      const results = await db
        .select({
          entityId: entityVectors.entityId,
          distance: drizzleSql<number>`embedding <-> ${embeddingWrapped}`,
        })
        .from(entityVectors)
        .where(eq(entityVectors.userId, 'test-drizzle'))
        .limit(1);
      console.log('✅ Drizzle SELECT with pgvector.toSql() successful:', results[0]);
    } catch (error) {
      console.error('❌ Drizzle SELECT with pgvector.toSql() failed:', error.message);
      console.error('   Error code:', error.code);
    }

    // Step 5: Test using raw postgres.js for comparison
    console.log('\n🔍 Test 4: Direct postgres.js SELECT (control)...');
    try {
      const embeddingWrapped = pgvector.toSql(testEmbedding);
      const results = await sql`
        SELECT entity_id, (embedding <-> ${embeddingWrapped}) as distance
        FROM entity_vectors
        WHERE user_id = 'test-drizzle'
        LIMIT 1
      `;
      console.log('✅ Direct postgres.js SELECT successful:', results[0]);
    } catch (error) {
      console.error('❌ Direct postgres.js SELECT failed:', error.message);
    }

    // Cleanup
    await sql`DELETE FROM entity_vectors WHERE user_id = 'test-drizzle'`;
    await sql`DELETE FROM entities WHERE user_id = 'test-drizzle'`;
    console.log('\n✅ Cleanup complete\n');

  } catch (error) {
   console.error('\n❌ TEST SUITE FAILED:');
    console.error('Error:', error);
  } finally {
    await sql.end();
  }
}

testDrizzleWithPgvector();
