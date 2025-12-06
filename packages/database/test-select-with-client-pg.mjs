/**
 * Test SELECT using EXACT same sql instance as repository
 */

import { sql } from './src/client-pg.js';
import pgvector from 'pgvector';

async function testSelectWithExistingSqlInstance() {
  console.log('\n📊 Testing SELECT with client-pg.js sql instance');
  console.log('==================================================\n');

  try {
    const testEmbedding = Array(1536).fill(0).map((_, i) => i / 1536);
    const embeddingWrapped = pgvector.toSql(testEmbedding);
    
    console.log('1️⃣ Querying entity_vectors with distance operator...');
    
    const results = await sql`
      SELECT
        entity_id as "entityId",
        user_id as "userId",
        (1 - (embedding <-> ${embeddingWrapped})) AS "relevanceScore"
      FROM entity_vectors
      WHERE user_id = 'test-storage'
      LIMIT 1
    `;
    
    console.log('✅ Query succeeded! Results:', results);
    
  } catch (error) {
    console.error('\n❌ Query FAILED:', error.message);
    console.error('Error code:', error.code);
    console.error('Full error:', error);
  } finally {
    // Don't close sql here as it might be used by other parts
    console.log('\n✅ Test complete\n');
  }
}

testSelectWithExistingSqlInstance();
