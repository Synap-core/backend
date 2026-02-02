#!/bin/bash
# Start local development environment

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

echo "🚀 Starting local development environment..."
echo ""

# Check if docker-compose.local.yml exists
if [ ! -f "docker-compose.local.yml" ]; then
    echo "❌ docker-compose.local.yml not found!"
    echo "Expected at: $ROOT_DIR/docker-compose.local.yml"
    exit 1
fi

# Check if .env.development.local exists
if [ ! -f ".env.development.local" ]; then
    echo "⚠️  .env.development.local not found!"
    echo ""
    echo "Running setup script to create it..."
    echo ""
    if [ -f "scripts/setup-dev-local.sh" ]; then
        ./scripts/setup-dev-local.sh
    else
        echo "❌ scripts/setup-dev-local.sh not found!"
        echo "Please run: ./scripts/setup-dev-local.sh"
        exit 1
    fi
fi

# Start Docker services
echo "🐳 Starting local Docker services..."
docker compose -f docker-compose.local.yml up -d

echo ""
echo "⏳ Waiting for services to be healthy..."
sleep 5

# Check services
echo ""
echo "📊 Service status:"
docker compose -f docker-compose.local.yml ps

echo ""
echo "✅ Local services started!"
echo ""
echo "📝 Next steps:"
echo "1. Run migrations: pnpm db:migrate"
echo "2. Start Inngest (separate terminal): npx inngest-cli@latest dev"
echo "3. Start API: pnpm dev:local"
echo ""
echo "📚 View logs: docker compose -f docker-compose.local.yml logs -f"
echo "🛑 Stop services: docker compose -f docker-compose.local.yml down"
