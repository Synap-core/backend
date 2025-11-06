#!/bin/bash

# Simple Test - Insert Event into Database
# This simulates what the API would do

echo "🧪 Inserting test event into database..."
echo ""

# Generate UUID (simple version)
EVENT_ID="test-$(date +%s)-$RANDOM"
TIMESTAMP=$(date +%s)000  # Milliseconds

# Content
CONTENT="Buy milk tomorrow at 3pm"

# Insert event
sqlite3 data/synap.db << EOF
INSERT INTO events (id, timestamp, type, data, source)
VALUES (
  '${EVENT_ID}',
  ${TIMESTAMP},
  'api/thought.captured',
  '{"content":"${CONTENT}","context":{},"capturedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}',
  'api'
);
EOF

echo "✅ Event logged to database"
echo "   Event ID: ${EVENT_ID}"
echo "   Content: ${CONTENT}"
echo ""

# Check events count
COUNT=$(sqlite3 data/synap.db "SELECT COUNT(*) FROM events;")
echo "📊 Total events in database: ${COUNT}"
echo ""

echo "⏳ Next steps:"
echo "   1. Start Inngest: pnpm --filter jobs dev (in another terminal)"
echo "   2. Add OPENAI_API_KEY to .env if not done"
echo "   3. Inngest will detect the event and process it (~5 seconds)"
echo "   4. Check results: sqlite3 data/synap.db \"SELECT * FROM entities;\""
echo ""
echo "💡 Open Inngest dashboard: http://localhost:8288"
echo ""

