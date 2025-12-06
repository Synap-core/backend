/**
 * Test to verify what type Drizzle actually stores for vector columns
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { entityVectors } from './src/schema/index.js';

const sql = postgres('postgresql://postgres:synap_dev_password@localhost:5432/synap');
const db = drizzle(sql);

async function testDrizzleVectorStorage() {
  console.log('\n📊 Testing Drizzle Vector Storage Type');
  console.log('========================================\n');

  try {
    const testEmbedding = Array(1536).fill(0).map((_, i) => i / 1536);
    
    // Clean up
    await sql`DELETE FROM entity_vectors WHERE user_id = 'test-storage'`;
    await sql`DELETE FROM entities WHERE user_id = 'test-storage'`;
    
    // Insert entity
    await sql`INSERT INTO entities (id, user_id, type, title) VALUES ('44444444-4444-4444-4444-444444444444', 'test-storage', 'note', 'Test')`;
    
    // Insert with Drizzle using plain number[] array
    console.log('1️⃣ Inserting with Drizzle (plain number[] array)...');
    await db.insert(entityVectors).values({
      entityId: '44444444-4444-4444-4444-444444444444',
      userId: 'test-storage',
      entityType: 'note',
      embedding: testEmbedding,
      embeddingModel: 'test',
      indexedAt: new Date(),
      updatedAt: new Date(),
    });
    console.log('✅ INSERT completed\n');
    
    // Check what type was actually stored
    console.log('2️⃣ Checking stored type in database...');
    const typeCheck = await sql`
      SELECT 
        entity_id,
        pg_typeof(embedding) as stored_type,
        vector_dims(embedding) as dimensions
      FROM entity_vectors
      WHERE entity_id = '44444444-4444-4444-4444-444444444444'
    `;
    console.log('✅ Stored type:', typeCheck[0]);
    console.log('');
    
    if (typeCheck[0].stored_type !== 'vector') {
      console.error('❌ PROBLEM: Drizzle stored as', typeCheck[0].stored_type, 'instead of vector!');
    } else {
      console.log('✅ Drizzle correctly stored as vector type');
    }
    
    // Clean up
    await sql`DELETE FROM entity_vectors WHERE user_id = 'test-storage'`;
    await sql`DELETE FROM entities WHERE user_id = 'test-storage'`;
    
  } catch (error) {
    console.error('\n❌ TEST FAILED:', error.message);
    console.error(error);
  } finally {
    await sql.end();
  }
}

testDrizzleVectorStorage();
