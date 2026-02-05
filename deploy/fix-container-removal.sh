#!/bin/bash
# Fix Docker container removal issue
# This script cleans up containers marked for removal

set -e

echo "🔧 Fixing Docker container removal issue..."

# Navigate to deploy directory
cd "$(dirname "$0")"

# 1. Stop all containers
echo "📦 Stopping all containers..."
docker compose down || true

# 2. Remove any containers marked for removal
echo "🗑️  Removing problematic containers..."
docker ps -a --filter "status=removing" --format "{{.ID}}" | xargs -r docker rm -f || true
docker ps -a --filter "name=synap-backend-postgres" --format "{{.ID}}" | xargs -r docker rm -f || true

# 3. Clean up orphaned containers
echo "🧹 Cleaning up orphaned containers..."
docker container prune -f || true

# 4. Remove the network if it exists (will be recreated)
echo "🌐 Cleaning up networks..."
docker network rm synap-backend_synap-net 2>/dev/null || true

# 5. Verify cleanup
echo "✅ Cleanup complete. Checking container status..."
docker ps -a | grep synap-backend || echo "No synap-backend containers found (good!)"

echo ""
echo "✅ Ready to run migrations again!"
echo "   Run: cd deploy && ../synap install --domain <your-domain>"
