#!/bin/bash
# Fix Realtime Build - Diagnostic and Rebuild Script

set -e

echo "=== Realtime Build Fix Script ==="
echo ""

# Check if we're in the right directory
if [ ! -f "docker-compose.yml" ]; then
    echo "❌ Error: Must run from deploy/ directory"
    exit 1
fi

echo "Step 1: Stopping realtime service..."
docker compose stop realtime || true

echo ""
echo "Step 2: Removing old realtime image..."
docker compose rm -f realtime || true
docker rmi $(docker images | grep 'backend-realtime' | awk '{print $3}') 2>/dev/null || true

echo ""
echo "Step 3: Rebuilding realtime image (this may take a few minutes)..."
docker compose build --no-cache realtime

echo ""
echo "Step 4: Verifying build output..."
if docker compose run --rm realtime test -f /app/dist/server.js; then
    echo "✅ server.js exists in image"
else
    echo "❌ ERROR: server.js NOT found in image!"
    echo "Checking what's in /app/dist/..."
    docker compose run --rm realtime ls -la /app/dist/ || echo "dist/ does not exist"
    exit 1
fi

echo ""
echo "Step 5: Starting realtime service..."
docker compose up -d realtime

echo ""
echo "Step 6: Waiting for service to start..."
sleep 5

echo ""
echo "Step 7: Checking service logs..."
docker compose logs --tail=20 realtime

echo ""
echo "=== Done ==="
echo "If you see errors, check the logs with: docker compose logs realtime"
