import postgres from 'postgres';

(async () => {
  const sql = postgres('postgresql://postgres:synap_dev_password@localhost:5432/synap');

  try {
    console.log('=== CHECKING FOR ANY ENTITIES (ANY USER) ===\n');

    const all = await sql`
      SELECT id, user_id, type, title, file_path, created_at
      FROM entities
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 10
    `;

    console.log(`Total entities: ${all.length}\n`);

    if (all.length > 0) {
      all.forEach((e, i) => {
        console.log(`${i + 1}. ID: ${e.id}`);
        console.log(`   User: ${e.user_id}`);
        console.log(`   Type: ${e.type}`);
        console.log(`   Title: ${e.title || 'NULL'}`);
        console.log(`   File: ${e.file_path || 'NULL'}`);
        console.log(`   Created: ${e.created_at}`);
        console.log('');
      });
    } else {
      console.log('❌ No entities found in database at all!');
    }

    console.log('\n=== CHECKING EVENTS ===\n');

    const events = await sql`
      SELECT id, event_type, user_id, aggregate_id, timestamp, data
      FROM events
      WHERE event_type LIKE 'entities.%'
      ORDER BY timestamp DESC
      LIMIT 5
    `;

    console.log(`Total entity events: ${events.length}\n`);

    events.forEach((e, i) => {
      console.log(`${i + 1}. ${e.event_type}`);
      console.log(`   User: ${e.user_id}`);
      console.log(`   Aggregate: ${e.aggregate_id}`);
      console.log(`   Time: ${e.timestamp}`);
      console.log(`   Data: ${JSON.stringify(e.data, null, 2)}`);
      console.log('');
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await sql.end();
  }
})();
