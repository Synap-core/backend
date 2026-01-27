#!/bin/bash
set -e

echo "🧹 Cleaning Docker environment on server..."

# Stop all containers
echo "Stopping containers..."
docker compose down

# Remove all Docker build cache
echo "Removing Docker build cache..."
docker builder prune -af

# Remove all images
echo "Removing all images..."
docker image prune -af

# Remove all volumes (careful - this removes data!)
echo "Removing volumes..."
docker volume prune -f

# Remove the backend image specifically
echo "Removing backend image..."
docker rmi synap/backend:latest || true

# Clean up any dangling images
echo "Cleaning up dangling images..."
docker system prune -af

echo "✅ Docker environment cleaned!"
echo ""
echo "🔨 Building fresh from repository..."

# Pull latest code
cd /srv/synap/synap-backend
git pull

# Build with no cache
cd /srv/synap
docker compose build --no-cache --pull backend

echo "✅ Fresh build complete!"
echo ""
echo "🚀 Starting services..."
docker compose up -d

echo "✅ Services started!"
echo ""
echo "📋 Checking logs..."
docker compose logs -f backend
