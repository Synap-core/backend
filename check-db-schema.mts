import postgres from 'postgres';

const sql = postgres('postgresql://postgres:synap_dev_password@localhost:5432/synap');

// Get table schema
const columns = await sql`
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'entities'
  ORDER BY ordinal_position
`;

console.log('=== Entities Table Columns ===');
columns.forEach(col => {
  console.log(`${col.column_name}: ${col.data_type} (${col.is_nullable})`);
});

// Check for entities
const entities = await sql`
  SELECT id, user_id, type, title, created_at
  FROM entities
  WHERE deleted_at IS NULL
  LIMIT 5
`;

console.log('\n=== Recent Entities ===');
console.log(JSON.stringify(entities, null, 2));

await sql.end();
