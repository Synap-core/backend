import postgres from 'postgres';

const sql = postgres('postgresql://postgres:synap_dev_password@localhost:5432/synap');

try {
  // Get table schema
  const columns = await sql`
    SELECT column_name, data_type, character_maximum_length
    FROM information_schema.columns
    WHERE table_name = 'entities'
    ORDER BY ordinal_position
  `;

  console.log('=== ENTITIES TABLE SCHEMA ===\n');
  columns.forEach(col => {
    const len = col.character_maximum_length ? ` (${col.character_maximum_length})` : '';
    console.log(`  ${col.column_name.padEnd(20)} ${col.data_type}${len}`);
  });

  // Check for test entity we just created
  console.log('\n=== ENTITIES IN DATABASE ===\n');
  const entities = await sql`
    SELECT id, user_id, type, title, file_url, file_path, created_at
    FROM entities  
    WHERE user_id = 'test-user-123'
    AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 5
  `;

  if (entities.length === 0) {
    console.log('  ❌ No entities found for test-user-123');
  } else {
    console.log(`  ✅ Found ${entities.length} entity(ies):`);
    entities.forEach(e => {
      console.log(`\n  ID: ${e.id}`);
      console.log(`  Type: ${e.type}`);
      console.log(`  Title: ${e.title}`);
      console.log(`  File URL: ${e.file_url || 'NULL'}`);
      console.log(`  File Path: ${e.file_path || 'NULL'}`);
      console.log(`  Created: ${e.created_at}`);
    });
  }

} catch (error) {
  console.error('Error:', error.message);
} finally {
  await sql.end();
}
