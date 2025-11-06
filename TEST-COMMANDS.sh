#!/bin/bash
# Test Commands for Synap Backend

API_URL="http://localhost:3000"
TOKEN="00a0896278b2ac5b19a8a3788ef1013a37a27d837c73ab2213aa6517414dbefd"

echo "🧪 Testing Synap Backend"
echo "======================="
echo ""

# Test 1: Health Check
echo "1. Health Check..."
curl -s "$API_URL/health" | jq '.' || echo "❌ Health check failed"
echo ""

# Test 2: Create Note (No RAG)
echo "2. Create Note (AI enrichment, no RAG)..."
curl -s -X POST "$API_URL/trpc/notes.create" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"Test note without RAG - should generate tags","autoEnrich":true,"useRAG":false}' | jq '.'
echo ""

# Test 3: Create Note (With RAG - needs OpenAI key)
echo "3. Create Note (with RAG - requires embeddings API key)..."
curl -s -X POST "$API_URL/trpc/notes.create" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"Test note with RAG enabled","autoEnrich":true,"useRAG":true}' | jq '.'
echo ""

# Test 4: Capture Thought (Simple)
echo "4. Capture Thought (triggers Inngest)..."
curl -s -X POST "$API_URL/trpc/capture.thought" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"Remember to update documentation"}' | jq '.'
echo ""

# Test 5: List Events
echo "5. List Events..."
curl -s "$API_URL/trpc/events.list?input=%7B%22json%22%3A%7B%22limit%22%3A5%7D%7D" \
  -H "Authorization: Bearer $TOKEN" | jq '.'
echo ""

echo "✅ Tests complete!"
echo ""
echo "📊 Check Inngest Dashboard: http://localhost:8288"
echo "🗄️  Check Database:"
echo "    sqlite3 apps/api/data/synap.db"
echo "    SELECT * FROM events ORDER BY timestamp DESC LIMIT 5;"

