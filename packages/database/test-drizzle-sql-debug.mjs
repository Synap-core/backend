/**
 * Test to see what SQL Drizzle actually generates with pgvector
 */

import postgres from 'postgres';
import pgvector from 'pgvector';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as drizzleSql, eq } from 'drizzle-orm';
import { entityVectors } from './src/schema/index.js';

const sql = postgres('postgresql://postgres:synap_dev_password@localhost:5432/synap', {
  debug: (connection, query, params) => {
    console.log('\n🔍 SQL Query:', query);
    console.log('📊 Parameters:', params);
    console.log('');
  }
});

const db = drizzle(sql);

async function testDrizzleSQLGeneration() {
  console.log('\n📊 Testing Drizzle SQL Generation with pgvector');
  console.log('=================================================\n');

  try {
    const testEmbedding = Array(1536).fill(0).map((_, i) => i / 1536);
    
    // Test what SQL Drizzle generates
    console.log('\n1️⃣ Testing Drizzle SELECT with pgvector.toSql()...\n');
    
    const embeddingWrapped = pgvector.toSql(testEmbedding);
    console.log('Type of wrapped embedding:', typeof embeddingWrapped);
    console.log('Wrapped embedding value (first 100 chars):', String(embeddingWrapped).substring(0, 100));
    
    try {
      const results = await db
        .select({
          entityId: entityVectors.entityId,
          distance: drizzleSql`embedding <-> ${embeddingWrapped}`,
        })
        .from(entityVectors)
        .where(eq(entityVectors.userId, 'test-drizzle'))
        .limit(1);
      
      console.log('✅ Query succeeded:', results);
    } catch (error) {
      console.error('❌ Query failed:', error.message);
      console.error('Error code:', error.code);
    }

    // Test with raw number array for comparison
    console.log('\n2️⃣ Testing Drizzle SELECT with raw number[]...\n');
    
    try {
      const results = await db
        .select({
          entityId: entityVectors.entityId,
          distance: drizzleSql`embedding <-> ${testEmbedding}`,
        })
        .from(entityVectors)
        .where(eq(entityVectors.userId, 'test-drizzle'))
        .limit(1);
      
      console.log('✅ Query succeeded:', results);
    } catch (error) {
      console.error('❌ Query failed:', error.message);
      console.error('Error code:', error.code);
    }

  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
  } finally {
    await sql.end();
  }
}

testDrizzleSQLGeneration();
