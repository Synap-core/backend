import postgres from 'postgres';

(async () => {
  const sql = postgres('postgresql://postgres:synap_dev_password@localhost:5432/synap');

  try {
    console.log('Adding missing columns to entities table...\n');

    await sql`
      ALTER TABLE entities
      ADD COLUMN IF NOT EXISTS file_url TEXT,
      ADD COLUMN IF NOT EXISTS file_path TEXT,
      ADD COLUMN IF NOT EXISTS file_size INTEGER,
      ADD COLUMN IF NOT EXISTS file_type TEXT,
      ADD COLUMN IF NOT EXISTS checksum TEXT
    `;

    console.log('✅ Columns added successfully!\n');

    // Verify
    const columns = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'entities'
      ORDER BY ordinal_position
    `;

    console.log('Current columns:');
    columns.forEach(c => console.log('  -', c.column_name));

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await sql.end();
  }
})();
