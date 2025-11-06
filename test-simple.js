/**
 * Simple Test - Direct Database Insert
 * Tests the event-sourcing workflow
 */

const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');

const db = new Database('./data/synap.db');

console.log('🧪 Simple Thought Capture Test\n');

// Insert an event directly
const eventId = randomUUID();
const timestamp = Date.now();

db.prepare(`
  INSERT INTO events (id, timestamp, type, data, source)
  VALUES (?, ?, ?, ?, ?)
`).run(
  eventId,
  timestamp,
  'api/thought.captured',
  JSON.stringify({
    content: "Buy milk tomorrow at 3pm",
    context: {},
    capturedAt: new Date().toISOString()
  }),
  'api'
);

console.log('✅ Event logged to database');
console.log(`   Event ID: ${eventId}`);
console.log(`   Type: api/thought.captured`);

// Check events
const events = db.prepare('SELECT COUNT(*) as count FROM events').get();
console.log(`\n📊 Total events in database: ${events.count}`);

// Check if Inngest will pick it up
console.log('\n⏳ Next steps:');
console.log('   1. Make sure Inngest dev server is running: pnpm --filter jobs dev');
console.log('   2. Inngest will detect the new event');
console.log('   3. AI will analyze (OpenAI) → ~2 seconds');
console.log('   4. Entity will be created automatically');
console.log('   5. Check: sqlite3 data/synap.db "SELECT * FROM entities;"');

console.log('\n💡 Or manually trigger by restarting Inngest dev server');

db.close();

