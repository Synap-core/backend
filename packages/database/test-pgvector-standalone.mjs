/**
 * Standalone test to isolate pgvector + postgres.js behavior
 * This bypasses Drizzle entirely to test the driver layer
 */

import postgres from 'postgres';
import pgvector from 'pgvector';

const sql = postgres('postgresql://postgres:synap_dev_password@localhost:5432/synap');

async function testPgvectorIntegration() {
  console.log('\n📊 Testing pgvector Integration');
  console.log('================================\n');

  try {
    // Step 1: Create test embedding (1536 dimensions as required)
    const testEmbedding = Array(1536).fill(0).map((_, i) => i / 1536);
    console.log('✅ Created test embedding:', testEmbedding.length, 'dimensions');

    // Step 2: Test with pgvector.toSql()
    const embeddingVectorWrapped = pgvector.toSql(testEmbedding);
    console.log('✅ Wrapped with pgvector.toSql():', typeof embeddingVectorWrapped);

    // Step 3: Insert using pgvector wrapped value
    console.log('\n📝 Testing INSERT with pgvector.toSql()...');
    await sql`
      INSERT INTO entities (id, user_id, type, title)
      VALUES ('22222222-2222-2222-2222-222222222222', 'test-pgvector', 'note', 'Test')
      ON CONFLICT (id) DO UPDATE SET title = 'Test'
    `;

    await sql`
      INSERT INTO entity_vectors (entity_id, user_id, entity_type, embedding)
      VALUES (
        '22222222-2222-2222-2222-222222222222',
        'test-pgvector',
        'note',
        ${embeddingVectorWrapped}
      )
      ON CONFLICT (entity_id) DO UPDATE SET embedding = ${embeddingVectorWrapped}
    `;
    console.log('✅ INSERT successful');

    // Step 4: Verify the data was stored correctly
    const stored = await sql`
      SELECT entity_id, pg_typeof(embedding) as type, vector_dims(embedding) as dims
      FROM entity_vectors
      WHERE entity_id = '22222222-2222-2222-2222-222222222222'
    `;
    console.log('✅ Stored data:', stored[0]);

    // Step 5: Test SELECT with distance operator using pgvector.toSql()
    console.log('\n🔍 Testing SELECT with distance operator...');
    const queryEmbedding = pgvector.toSql(testEmbedding);
    
    const results = await sql`
      SELECT
        entity_id,
        (embedding <-> ${queryEmbedding}) as distance
      FROM entity_vectors
      WHERE user_id = 'test-pgvector'
      LIMIT 1
    `;
    console.log('✅ SELECT with distance successful:', results[0]);

    // Step 6: Clean up
    await sql`DELETE FROM entity_vectors WHERE user_id = 'test-pgvector'`;
    await sql`DELETE FROM entities WHERE user_id = 'test-pgvector'`;
    console.log('✅ Cleanup complete');

    console.log('\n✅ ALL TESTS PASSED - pgvector integration works!\n');

  } catch (error) {
    console.error('\n❌ TEST FAILED:');
    console.error('Error:', error.message);
    console.error('Details:', error);
    console.error('\n');
  } finally {
    await sql.end();
  }
}

testPgvectorIntegration();
